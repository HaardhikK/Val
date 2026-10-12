"""Runs the Needle training kit (cactus-needle) with everything kept inside the repo.

The kit caches engines and weights under ~/.cache and sends usage counts by default; this wrapper points HOME,
HF_HOME and the JAX caches at <repo>/.cache/ and turns telemetry off before the kit is imported.

  python scripts/needle-tool.py cli <needle args...>        the kit's own CLI (download, ...)
  python scripts/needle-tool.py rows <rows dir> <kit dir>    checks your rows and writes them in the kit's format
                                                            (the app's tool list in every row; see kit_rows)
  python scripts/needle-tool.py finetune-mlx data.jsonl --out A.safetensors
                                                            the kit's LoRA fine-tune on the Apple GPU (see finetune_mlx)
  python scripts/needle-tool.py build --lora A --out F.cact  merge it at the published 2/4-bit mix, keep a confidence head
                                [--conf-data train.jsonl]   ... and re-fit that head to the tuned model (see fit_confidence)

The kit's own `needle finetune` runs JAX on the CPU here (~38 s a step, hours for this set), and its `needle build`
writes every matrix at 4 bits (63 MB instead of 35) and drops the confidence head, which the app's router needs.
"""

import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CACHE = os.path.join(REPO, ".cache")
NEEDLE = os.path.join(CACHE, "needle")
CHECKPOINT = os.path.join(NEEDLE, "checkpoints", "needle3.safetensors")

os.environ["HOME"] = os.path.join(CACHE, "needle-home")
os.environ["HF_HOME"] = os.path.join(CACHE, "hf")
os.environ["NEEDLE_TELEMETRY"] = "0"
os.environ["DO_NOT_TRACK"] = "1"
os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", os.path.join(CACHE, "jax"))
os.makedirs(os.environ["HOME"], exist_ok=True)


def ship_bits(config):
    """Bits per weight as the published archive ships them, from the checkpoint's own spec
    ("embedding=4,stack/mhc=4,default=2": the attention and engram weights run at 2 bits on the phone).
    Returns name -> bits for a flat parameter name ("stack/layers/block/self_attn/q_proj/kernel")."""
    spec = dict(part.split("=") for part in config.weight_bits.split(","))
    default = int(spec.pop("default"))
    return lambda name: next((int(b) for prefix, b in spec.items() if name.startswith(prefix)), default)


def _export_name_to_flat(name):
    if name == "embedding":
        return "embedding/embedding"
    if name.startswith("mhc_phi"):
        return "stack/" + name
    return "stack/layers/" + name  # layer and engram matrices: the default bits


def build(argv):
    import argparse

    from needle.model.finetune import merge_lora, rung
    from needle.model.checkpoints import read_adapter
    from needle.model.run import load_checkpoint
    from needle.model.architecture import effective_kv_window
    from needle.model.export import read_tokenizer_blob, write_export
    from needle.model.quantize import WEIGHT_BITS
    import jax.numpy as jnp

    p = argparse.ArgumentParser(prog="needle-tool build")
    p.add_argument("--lora", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--base-cact", default=os.path.join(CACHE, "models", "cmd", "needle3.cact"), help="tokenizer source")
    p.add_argument("--conf-data", default=None, help="JSONL to re-fit the confidence head on (else keep the base head)")
    p.add_argument("--engine", default=os.path.join(NEEDLE, "macos-arm64", "needle"), help="engine that labels --conf-data")
    p.add_argument("--conf-steps", type=int, default=400)
    a = p.parse_args(argv)

    import jax
    import numpy as np
    params, config, _ = load_checkpoint(CHECKPOINT, return_run=True)
    config.dtype = "float32"
    params = jax.tree.map(lambda x: np.asarray(x).astype(np.float32), params)
    adapter = read_adapter(a.lora)
    lora = {tuple(k.split("/")): {"A": jnp.asarray(v["A"]), "B": jnp.asarray(v["B"])} for k, v in adapter["lora"].items()}
    params = merge_lora(params, lora, adapter["scale"])
    print(f"  merged    {len(lora)} weight groups", flush=True)
    params, config = rung(params, config, None)

    def export_archive(params):
        # The kit exports every matrix at 4 bits (~63 MB); keep the published mix instead, so it stays ~35 MB.
        import needle.model.export as export
        bits_of, kit_q = ship_bits(config), export._q

        def q_mixed(name, mat, bits, group):
            bits = bits if "_head." in name else bits_of(_export_name_to_flat(name))
            export.WEIGHT_BITS = bits  # the kit's packer is generic (LSB-first, Lloyd-Max codebook) but guards on this
            try:
                return kit_q(name, mat, bits, group)
            finally:
                export.WEIGHT_BITS = WEIGHT_BITS

        export._q = q_mixed
        try:
            info = write_export(params, config, a.out, bits=WEIGHT_BITS, tokenizer=read_tokenizer_blob(a.base_cact),
                                kv_window=effective_kv_window(config))
        finally:
            export._q = kit_q
        print(f"  wrote     {info['path']}  {info['bytes'] / 1e6:.2f} MB  {config.weight_bits} A8", flush=True)

    export_archive(params)  # with the base confidence head
    if a.conf_data:
        params = fit_confidence(params, config, a.out, a.engine, a.conf_data, a.conf_steps)
        export_archive(params)  # with the re-fitted head


def finetune_mlx(argv):
    """The kit's LoRA fine-tune (same targets, init, schedule, adapter file), run on the Apple GPU through the kit's own
    MLX forward instead of JAX on the CPU (~38 s a step there). The forward uses the shipped numerics: CQ weights at
    the published bits (ship_bits: 2 for the LoRA targets, not the kit's uniform 4) with straight-through gradients, A8."""
    import argparse
    import math
    import time

    import mlx.core as mx
    import mlx.optimizers as optim
    import numpy as np
    from needle.model.architecture_mlx import forward, to_mlx
    from needle.model.checkpoints import write_adapter
    from needle.model.finetune import fit_max_len, load_jsonl, lora_target_paths
    from needle.model.quantize_mlx import cq_ste_leaf, is_quant_leaf
    from needle.model.run import load_checkpoint
    from needle.model.tokenizer import get_tokenizer

    p = argparse.ArgumentParser(prog="needle-tool finetune-mlx")
    p.add_argument("jsonl_path")
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--lora-rank", type=int, default=16)
    p.add_argument("--lora-alpha", type=float, default=32.0)
    p.add_argument("--max-len", type=int, default=640)
    p.add_argument("--val-split", type=float, default=0.1)
    p.add_argument("--patience", type=int, default=1, help="stop after this many epochs without a better val loss")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)

    params, config = load_checkpoint(CHECKPOINT)
    config.dtype = "float32"
    paths = ["/".join(k) for k in lora_target_paths(params)]
    flat = to_mlx(params)
    tok = get_tokenizer(config.vocab_size)
    max_len = fit_max_len(a.jsonl_path, tok, a.max_len)
    seqs, masks = load_jsonl(a.jsonl_path, tok, max_len)
    rng = np.random.default_rng(a.seed)
    n_val = min(int(len(seqs) * a.val_split), len(seqs) - 1)
    order = rng.permutation(len(seqs))
    seqs, masks = seqs[order], masks[order]
    val = (seqs[:n_val], masks[:n_val])
    seqs, masks = seqs[n_val:], masks[n_val:]
    print(f"  backend   mlx (gpu)  float32\n  data      {len(seqs)} train  {n_val} val  seq_len {max_len}", flush=True)

    # Frozen weights are quantised once; only the LoRA targets are re-quantised each step (STE passes their gradient).
    bits_of = ship_bits(config)
    frozen = {k: (cq_ste_leaf(k, v, bits_of(k)) if is_quant_leaf(k, v) else v) for k, v in flat.items() if k not in paths}
    mx.eval(frozen)
    base = {k: flat[k] for k in paths}
    scale = a.lora_alpha / a.lora_rank
    key = mx.random.key(a.seed)
    lora = {}
    for k in paths:
        w = base[k]
        key, sub = mx.random.split(key)
        lead, (din, dout) = w.shape[:-2], w.shape[-2:]
        lora[k] = {"A": mx.random.normal(lead + (din, a.lora_rank), key=sub) / a.lora_rank,
                   "B": mx.zeros(lead + (a.lora_rank, dout))}
    print(f"  lora      rank {a.lora_rank}  alpha {a.lora_alpha:g}  {len(paths)} weight groups", flush=True)

    def loss_fn(lora, ids, mask):
        p_ = dict(frozen)
        for k in paths:
            p_[k] = cq_ste_leaf(k, base[k] + scale * (lora[k]["A"] @ lora[k]["B"]), bits_of(k))
        logits = forward(p_, config, ids, quant=True)[:, :-1]
        tgt, m = ids[:, 1:], mask[:, 1:]
        ce = mx.logsumexp(logits, axis=-1) - mx.take_along_axis(logits, tgt[..., None], axis=-1)[..., 0]
        return (ce * m).sum() / mx.maximum(m.sum(), 1.0)

    steps_per_epoch = -(-len(seqs) // a.batch_size)
    total = a.epochs * steps_per_epoch
    warm = max(1, total // 20)
    sched = optim.join_schedules([optim.linear_schedule(0.0, a.lr, warm), optim.cosine_decay(a.lr, total - warm)], [warm])
    opt = optim.AdamW(learning_rate=sched, weight_decay=1e-4)
    grad_fn = mx.value_and_grad(loss_fn)
    eval_fn = loss_fn

    def clip(g, limit=1.0):
        leaves = [x for d in g.values() for x in d.values()]
        norm = math.sqrt(sum(float((x * x).sum()) for x in leaves))
        f = min(1.0, limit / (norm + 1e-6))
        return {k: {n: x * f for n, x in d.items()} for k, d in g.items()} if f < 1 else g

    best, best_lora, bad, step, t0 = float("inf"), lora, 0, 0, time.time()
    for epoch in range(a.epochs):
        order = rng.permutation(len(seqs))
        for s in range(0, len(seqs), a.batch_size):
            idx = order[s:s + a.batch_size]
            loss, g = grad_fn(lora, mx.array(seqs[idx]), mx.array(masks[idx]))
            lora = opt.apply_gradients(clip(g), lora)
            mx.eval(lora, opt.state, loss)
            step += 1
            if step % 10 == 0 or step == 1:
                print(f"  step      {step}/{total}  loss {float(loss):.4f}  {time.time() - t0:.0f}s", flush=True)
        v = float(np.mean([float(eval_fn(lora, mx.array(val[0][i:i + 16]), mx.array(val[1][i:i + 16])))
                           for i in range(0, n_val, 16)])) if n_val else 0.0
        print(f"  epoch     {epoch + 1}/{a.epochs}  val {v:.4f}  {time.time() - t0:.0f}s", flush=True)
        if v < best - 1e-4:
            best, best_lora, bad = v, {k: dict(d) for k, d in lora.items()}, 0
        else:
            bad += 1
            if bad >= a.patience:
                print("  early stop (val loss stopped improving)", flush=True)
                break
    write_adapter(a.out, {"lora": {k: {"A": np.asarray(d["A"]), "B": np.asarray(d["B"])} for k, d in best_lora.items()},
                          "scale": float(scale), "base": CHECKPOINT, "rank": a.lora_rank, "seed": a.seed})
    print(f"  adapter   {a.out}  best val {best:.4f}", flush=True)


def quantize_shipped(params, config):
    """The JAX params as the archive ships them: CQ at ship_bits per matrix; probe heads stay float (they quantise
    themselves at HEAD_BITS inside the forward)."""
    import jax
    from needle.model.architecture import HEAD_KEYS
    from needle.model.quantize import _is_quant_leaf, _reduces_second_last, cq_quantize, leaf_name

    bits_of = ship_bits(config)

    def q(path, leaf):
        name = leaf_name(path)
        if name.split("/", 1)[0] in HEAD_KEYS or not _is_quant_leaf(path, leaf):
            return leaf
        if _reduces_second_last(path):
            return jax.numpy.swapaxes(cq_quantize(jax.numpy.swapaxes(leaf, -1, -2), bits_of(name)), -1, -2)
        return cq_quantize(leaf, bits_of(name))

    return jax.tree_util.tree_map_with_path(q, params)


def probe_reads(qparams, config, head, prompts, batch=8):
    """What the confidence head's (frozen) probes read from each prompt (BOS + rendered prompt): per layer and probe,
    the attention-pooled, unit-RMS hidden state, shape (N, layers+1, probes, d). The rest of the head trains on these,
    so the 20-layer forward runs once per prompt."""
    import math
    import jax
    import jax.numpy as jnp
    import numpy as np
    from needle.model.architecture import SimpleAttentionNetwork, _rms_unit
    from needle.model.quantize import configure_deploy, head_weight
    from needle.model.tokenizer import BOS_ID, PAD_ID, get_tokenizer

    tok = get_tokenizer(config.vocab_size)
    model = SimpleAttentionNetwork(config)
    configure_deploy(act_bits=getattr(config, "act_bits", 8), kv_bits=getattr(config, "kv_bits", 8))
    probes = head_weight(jnp.asarray(head["probes"], jnp.float32), True)

    @jax.jit
    def read(p, t):
        cells, keep, row_keep = model.apply({"params": p}, t, quant=True, method=model._head_cells)
        cf = cells.astype(jnp.float32)
        scores = jnp.einsum("btld,lkd->blkt", cf, probes) / math.sqrt(cf.shape[-1])
        scores = jnp.where(keep[:, None, None, :] > 0, scores, -jnp.inf)
        return _rms_unit(jnp.einsum("blkt,btld->blkd", jax.nn.softmax(scores, axis=-1), cf)), row_keep

    out, row_keep = [], None
    for s in range(0, len(prompts), batch):
        ids = [[BOS_ID] + tok.encode(x) for x in prompts[s:s + batch]]
        width = 1 << (max(map(len, ids)) - 1).bit_length()
        arr = np.full((len(ids), width), PAD_ID, np.int32)
        for i, x in enumerate(ids):
            arr[i, :len(x)] = x
        r, row_keep = read(qparams, jnp.asarray(arr))
        out.append(np.asarray(r, np.float32))
    return np.concatenate(out), (None if row_keep is None else np.asarray(row_keep))


def head_logit(h, r, row_keep):
    """ConfidenceHead after the probes (architecture.probe_pool + HeadProjection), on probe_reads output."""
    import math
    import jax
    import jax.numpy as jnp
    from needle.model.quantize import head_weight

    b, l1, k, d = r.shape
    query = head_weight(h["query"], True)
    rg = r * h["gain"][None, :, :, None]
    u = jnp.einsum("blkd,qd->bqlk", rg, query) / math.sqrt(d) + h["row_bias"][None]
    if row_keep is not None:
        u = jnp.where(row_keep[None, None, :, None] > 0, u, -jnp.inf)
    w = jax.nn.softmax(u.reshape(b, query.shape[0], l1 * k), axis=-1)
    pooled = jnp.einsum("bqm,bmd->bqd", w, rg.reshape(b, l1 * k, d)).reshape(b, -1)
    kernel = head_weight(h["proj"]["kernel"], True, reduce_second_last=True)
    return pooled @ kernel + h["proj"]["bias"]


def engine_answers(engine, archive, queries):
    """The raw /complete reply of the engine (the phone's server) for each query, each its own conversation."""
    import json
    import socket
    import subprocess
    import time
    import urllib.request

    tools = os.path.join(REPO, "android", "app", "src", "main", "assets", "tools.json")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = subprocess.Popen([engine, "--model", archive, "--tools", tools, "--serve", "--port", str(port), "--max", "96"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def post(path, body):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body, ensure_ascii=False).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode()

    try:
        for _ in range(120):
            try:
                post("/reset", {})
                break
            except OSError:
                time.sleep(0.25)
        out = []
        for q in queries:
            post("/reset", {})
            out.append(json.loads(post("/complete", {"input": q})))
        return out
    finally:
        srv.terminate()
        srv.wait(5)


def fit_confidence(params, config, archive, engine, data_path, steps):
    """Re-fits the confidence head to the tuned weights: P(the call the app receives is right).

    The engine scores confidence with this head over the prompt plus its own generated answer (thinking line and the
    raw calls, before it suppresses ungrounded ones; checked against the base archive, r = 0.997). So each training
    query is answered by the engine on the freshly built archive, labelled right or wrong against the reference (as
    needle-eval.py scores), and the head's pooling and projection are trained on those texts with the probes and the
    language model frozen. Class-balanced; 15% held out to report how well it separates.
    """
    import json
    import jax
    import jax.numpy as jnp
    import numpy as np
    import optax
    from needle.model.finetune import read_examples, render_example

    ev = __import__("runpy").run_path(os.path.join(REPO, "scripts", "needle-eval.py"), run_name="needle_eval")
    rows = list(read_examples(data_path))
    raw = engine_answers(engine, archive, [r["query"] for r in rows])
    texts, labels = [], []
    for r, out in zip(rows, raw):
        want = r["answers"][0] if r["answers"] else {"name": "none", "arguments": {}}
        got = (out.get("function_calls") or [{"name": "none", "arguments": {}}])[0]
        right = got.get("name") == want["name"] and ev["args_match"](want["name"], got.get("arguments") or {},
                                                                     want["arguments"], [])
        calls = (out.get("function_calls") or []) + (out.get("suppressed_calls") or [])
        gen = ("<think>\n" + (out.get("reasoning") or "") + "\n</think>\n<tool_call>"
               + json.dumps(calls, separators=(",", ":"), ensure_ascii=False) + "</tool_call>")
        texts.append(render_example({**r, "answers": []})[0] + gen)
        labels.append(1.0 if right else 0.0)
    y = np.asarray(labels, np.float32)
    print(f"  conf data {len(y)} answers  right {int(y.sum())}  wrong {int(len(y) - y.sum())}", flush=True)
    if y.min() == y.max():
        print("  conf      one class only: keeping the base head", flush=True)
        return params

    head0 = params["confidence_head"]
    r, row_keep = probe_reads(quantize_shipped(params, config), config, head0, texts)
    rk = None if row_keep is None else jnp.asarray(row_keep)
    r_all, y_all = jnp.asarray(r), jnp.asarray(y)
    order = np.random.default_rng(0).permutation(len(y))
    n_val = len(y) * 15 // 100
    va, tr = order[:n_val], order[n_val:]
    train = jax.tree.map(lambda v: jnp.asarray(v, jnp.float32), {k: v for k, v in head0.items() if k != "probes"})
    w_pos, w_neg = 0.5 / max(y[tr].mean(), 1e-3), 0.5 / max(1 - y[tr].mean(), 1e-3)

    def logits(h, idx):
        return head_logit(h, r_all[idx], rk)[:, 0]

    def loss_fn(h, idx):
        t = y_all[idx]
        return (jnp.where(t > 0.5, w_pos, w_neg) * optax.sigmoid_binary_cross_entropy(logits(h, idx), t)).mean()

    opt = optax.adamw(1e-3, weight_decay=1e-3)
    state = opt.init(train)
    step = jax.jit(lambda h, s, idx: (lambda l, g: (*opt.update(g, s, h), l))(*jax.value_and_grad(loss_fn)(h, idx)))
    rng = np.random.default_rng(1)

    def report(h, tag):
        p = np.asarray(jax.nn.sigmoid(logits(h, va)))
        pos, neg = p[y[va] > 0.5], p[y[va] < 0.5]
        auc = float(np.mean(pos[:, None] > neg[None, :])) if len(pos) and len(neg) else float("nan")
        print(f"  conf {tag:<5} held-out AUC {auc:.3f}  right p50 {np.median(pos):.2f}  wrong p50 {np.median(neg):.2f}"
              f"  wrong p90 {np.quantile(neg, .9) if len(neg) else float('nan'):.2f}", flush=True)

    report(train, "base")
    for s in range(steps):
        idx = rng.choice(tr, size=min(64, len(tr)), replace=False)
        updates, state, loss = step(train, state, idx)
        train = optax.apply_updates(train, updates)
    report(train, "tuned")
    params = dict(params)
    params["confidence_head"] = {**jax.tree.map(np.asarray, train), "probes": np.asarray(head0["probes"])}
    return params


def kit_rows(argv):
    """Checks the rows in <rows dir> and writes them to <kit dir> in the kit's format (the app's tool list in every row).

    Rows are your own, one JSON object per line, never committed (the default dir is .cache/needle/rows/):
      train.jsonl       required  {"query": "set a timer for ten minutes", "answers": [{"name": "set_timer", "arguments": {"minutes": 10}}]}
      test.jsonl        required  held-out rows, same format; "accept": [...] lists other argument values that count as right
      calib.jsonl       optional  fresh rows for the confidence head (else train.jsonl is reused, which is less honest)
      test-rules.jsonl  optional  questions the app answers by its own rules: Needle must answer or stay out, never act
    "answers" is [] for chatter that should not call any tool. "reasoning" is optional (a short line is made up).
    Tool names and argument keys must exist in android/app/src/main/assets/tools.json."""
    import json

    if len(argv) != 2:
        sys.exit("usage: needle-tool.py rows <rows dir> <kit dir>")
    src, out = argv
    tools = [t.get("function", t) for t in json.load(open(os.path.join(REPO, "android", "app", "src", "main", "assets", "tools.json")))]
    params = {t["name"]: set((t.get("parameters") or {}).get("properties", {})) for t in tools}

    def reason(answers):
        if not answers:
            return "Chatter, not a request -> no tool."
        name, args = answers[0]["name"], answers[0]["arguments"]
        if not args:
            return f"-> {name}."
        k, v = next(iter(args.items()))
        return f"-> {name} with {k} {json.dumps(v, ensure_ascii=False)}."

    def read(name, required):
        path = os.path.join(src, name)
        if not os.path.isfile(path):
            if required:
                sys.exit(f"missing {path}\nPut your own rows there first (format in the README under 'fine-tune Needle', or in this script's kit_rows).")
            return None
        rows = []
        for i, line in enumerate(open(path, encoding="utf-8"), 1):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
                assert isinstance(r.get("query"), str) and r["query"].strip(), "no query"
                assert isinstance(r.get("answers"), list), "no answers list"
                for a in r["answers"]:
                    assert a.get("name") in params, f"unknown tool {a.get('name')!r}"
                    extra = set(a.get("arguments") or {}) - params[a["name"]]
                    assert not extra, f"unknown arguments {sorted(extra)} for {a['name']}"
                    a["arguments"] = a.get("arguments") or {}
            except (ValueError, AssertionError) as e:
                sys.exit(f"{path}:{i}: {e}")
            rows.append(r)
        if not rows:
            sys.exit(f"{path} has no rows")
        return rows

    splits = {"train": read("train.jsonl", True), "test": read("test.jsonl", True),
              "calib": read("calib.jsonl", False), "test-rules": read("test-rules.jsonl", False)}
    if splits["calib"] is None:
        print("no calib.jsonl: the confidence head is fitted on train.jsonl", flush=True)
        splits["calib"] = splits["train"]
    os.makedirs(out, exist_ok=True)
    for split, rows in splits.items():
        if rows is None:
            continue
        with open(os.path.join(out, f"{split}.jsonl"), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps({"query": r["query"], "tools": tools, "reasoning": r.get("reasoning") or reason(r["answers"]),
                                    "answers": r["answers"]}, ensure_ascii=False) + "\n")
        print(f"  {split:<10} {len(rows)} rows", flush=True)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "rows":
        kit_rows(sys.argv[2:])
    elif len(sys.argv) >= 2 and sys.argv[1] == "cli":
        sys.argv = ["needle"] + sys.argv[2:]
        from needle.cli import main
        main()
    elif len(sys.argv) >= 2 and sys.argv[1] == "finetune-mlx":
        finetune_mlx(sys.argv[2:])
    elif len(sys.argv) >= 2 and sys.argv[1] == "build":
        build(sys.argv[2:])
    else:
        sys.exit(__doc__)
