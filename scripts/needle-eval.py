"""Scores a Needle .cact on Charm's held-out commands, through the same server the phone runs (POST /reset, /complete).

  python3 -I scripts/needle-eval.py --engine <main>/.cache/needle/macos-arm64/needle --model <file.cact> \
      [--test .cache/needle/rows/test.jsonl] [--json out.json]

The rows are your own (format in scripts/needle-tool.py, kit_rows); they are never committed.

Reports: exact tool, tool + arguments (normalised: case, punctuation, articles; places and notes also accept the forms
in the row's "accept"; answer_question and "none" count as the same, both go to the chat model), per-tool accuracy, the confidence of right vs wrong picks, and what the app would do at each
action threshold (Router.kt: an action fires only when its tool is an action and confidence >= threshold; anything
else goes to the chat model, which is right for answer_question and "none").
"""

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ACTIONS = {"remember_note", "recall_note", "set_timer", "dance", "take_photo", "describe_photo", "where_am_i", "navigate_to"}
CHAT = {"answer_question", "none"}


def norm(v):
    if isinstance(v, (int, float)):
        return round(float(v), 3)
    s = str(v).lower().replace("ß", "ss").replace("ä", "a").replace("ö", "o").replace("ü", "u")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\b(the|a|an|my|please|um|uh|uhm)\b", " ", s)
    return " ".join(s.split())


def args_match(name, got, want, accept):
    if name in ("answer_question", "none", "where_am_i", "take_photo", "describe_photo", "dance"):
        return True  # no arguments the app relies on (a question is answered from the transcript)
    key = {"navigate_to": "place", "remember_note": "text", "recall_note": "topic", "set_timer": "minutes"}[name]
    g = got.get(key)
    if g is None:
        return False
    if name == "set_timer":
        try:
            return abs(float(g) - float(want[key])) < 1e-6
        except (TypeError, ValueError):
            return False
    ok = {norm(want[key])} | {norm(a) for a in accept}
    return norm(g) in ok


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def post(port, path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--engine", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--tools", default=os.path.join(ROOT, "android/app/src/main/assets/tools.json"))
    p.add_argument("--test", default=os.path.join(ROOT, ".cache", "needle", "rows", "test.jsonl"))
    p.add_argument("--json", default=None, help="write per-row results here")
    a = p.parse_args()

    if not os.path.isfile(a.test):
        sys.exit(f"missing {a.test}\nPut your own held-out rows there, or pass --test (format in the README under 'fine-tune Needle').")
    rows = [json.loads(l) for l in open(a.test, encoding="utf-8") if l.strip()]
    port = free_port()
    env = dict(os.environ, NEEDLE_TELEMETRY="0", DO_NOT_TRACK="1")
    srv = subprocess.Popen([a.engine, "--model", a.model, "--tools", a.tools, "--serve", "--port", str(port),
                            "--max", "96", "--threads", "4"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    try:
        for _ in range(120):
            try:
                post(port, "/reset", {})
                break
            except OSError:
                time.sleep(0.25)
        results, t0 = [], time.time()
        for r in rows:
            want = r["answers"][0] if r["answers"] else {"name": "none", "arguments": {}}
            post(port, "/reset", {})
            out = json.loads(post(port, "/complete", {"input": r["query"]}))
            calls = out.get("function_calls") or []
            got = calls[0] if calls else {"name": "none", "arguments": {}}
            gargs = got.get("arguments") or {}
            if isinstance(gargs, str):
                gargs = json.loads(gargs) if gargs.strip().startswith("{") else {}
            conf = out.get("confidence")
            # answer_question and "none" both send the utterance to the chat model (Router.kt), so either is right there.
            tool_ok = got.get("name") == want["name"] or (got.get("name") in CHAT and want["name"] in CHAT)
            full_ok = tool_ok and args_match(want["name"], gargs, want["arguments"], r.get("accept", []))
            results.append({"query": r["query"], "want": want, "got": {"name": got.get("name"), "arguments": gargs},
                            "confidence": conf, "tool_ok": tool_ok, "full_ok": full_ok})
        secs = (time.time() - t0) / max(1, len(rows))
    finally:
        srv.terminate()
        srv.wait(5)

    n = len(results)
    print(f"model {os.path.basename(a.model)}  {os.path.getsize(a.model) / 1e6:.2f} MB  rows {n}  {secs * 1000:.0f} ms/query (Mac)")
    print(f"exact tool       {sum(x['tool_ok'] for x in results)}/{n}")
    print(f"tool + args      {sum(x['full_ok'] for x in results)}/{n}")
    by = {}
    for x in results:
        b = by.setdefault(x["want"]["name"], [0, 0, 0])
        b[0] += 1
        b[1] += x["tool_ok"]
        b[2] += x["full_ok"]
    for k in sorted(by):
        t, ok, full = by[k]
        print(f"  {k:<16} tool {ok:>3}/{t:<3} full {full:>3}/{t}")

    confs = [x for x in results if isinstance(x["confidence"], (int, float))]
    if confs:
        def dist(xs):
            v = sorted(xs)
            if not v:
                return "-"
            q = lambda f: v[min(len(v) - 1, int(f * len(v)))]
            return f"n={len(v)} min {v[0]:.2f} p10 {q(.1):.2f} p50 {q(.5):.2f} p90 {q(.9):.2f} max {v[-1]:.2f}"
        print("confidence, right picks:", dist([x["confidence"] for x in confs if x["full_ok"]]))
        print("confidence, wrong picks:", dist([x["confidence"] for x in confs if not x["full_ok"]]))
        print("app outcome by threshold (action fires if tool is an action and conf >= t):")
        for t in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
            good = wrong_fire = missed = 0
            for x in results:
                fires = x["got"]["name"] in ACTIONS and (x["confidence"] or 0) >= t
                if fires:
                    if x["full_ok"]:
                        good += 1
                    else:
                        wrong_fire += 1
                elif x["want"]["name"] in CHAT:
                    good += 1
                else:
                    missed += 1
            print(f"  t={t:.1f}  right {good:>3}/{n}  wrong action {wrong_fire:>3}  action sent to chat {missed:>3}")
    else:
        print("confidence: none reported")
    if a.json:
        json.dump(results, open(a.json, "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    sys.exit(main())
