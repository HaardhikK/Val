#!/bin/sh
# Fine-tunes Needle 3 on your own command rows and writes .cache/models/cmd/needle3-val.cact (the base needle3.cact stays).
# Everything lives in the repo: the kit in .venv, weights and engines in .cache/needle/, telemetry off (scripts/needle-tool.py).
# The rows are yours and stay out of git: put them in .cache/needle/rows/ (or set NEEDLE_ROWS to another folder):
#   train.jsonl (required), test.jsonl (required), calib.jsonl and test-rules.jsonl (optional).
# Row format: scripts/needle-tool.py (kit_rows), or the README.
# Run from the repo root on an Apple-silicon Mac:  sh scripts/train-needle.sh
# About 40 min for ~1,200 rows (training ~30 on the GPU). Then CHARM_NEEDLE=val sh scripts/prepare-phone.sh puts it on the phone.
set -eu
cd "$(dirname "$0")/.."
PY=".venv/bin/python"
N=".cache/needle"
ROWS="${NEEDLE_ROWS:-$N/rows}"
export PIP_CACHE_DIR=".cache/pip"

# 0. Your rows: stop early, before any download, when they are missing.
for f in train.jsonl test.jsonl; do
  if [ ! -s "$ROWS/$f" ]; then
    echo "missing $ROWS/$f" >&2
    echo "Put your own rows there first (one JSON object per line, format in the README under 'fine-tune Needle')." >&2
    exit 1
  fi
done
[ -x "$PY" ] || { echo "missing $PY: run  python3 -m venv .venv  first" >&2; exit 1; }

# 1. The training kit (JAX, flax, optax come with it) and MLX for the Apple GPU, pinned.
"$PY" -m pip install "cactus-needle[train]==3.2.0" "mlx==0.29.3"
# 2. The training checkpoint (242 MB) and the macOS engine for scoring and labelling, into .cache/needle/.
[ -f "$N/checkpoints/needle3.safetensors" ] || "$PY" scripts/needle-tool.py cli download needle3.safetensors --out "$N"
[ -x "$N/macos-arm64/needle" ] || "$PY" scripts/needle-tool.py cli download macos-arm64 --out "$N"
# 3. The data: your rows, checked and written in the kit's format (the app's tool list in every row).
"$PY" scripts/needle-tool.py rows "$ROWS" "$N/data"
# 4. Score the base, train the LoRA adapter, merge it (re-fitting the confidence head), score the result.
python3 -I scripts/needle-eval.py --engine "$N/macos-arm64/needle" --model .cache/models/cmd/needle3.cact \
  --test "$ROWS/test.jsonl" --json "$N/eval-base.json"
mkdir -p "$N/runs"
"$PY" scripts/needle-tool.py finetune-mlx "$N/data/train.jsonl" --epochs 2 --batch-size 8 --lr 3e-4 --seed 0 \
  --out "$N/runs/val-lora.safetensors"
"$PY" scripts/needle-tool.py build --lora "$N/runs/val-lora.safetensors" --conf-data "$N/data/calib.jsonl" \
  --out .cache/models/cmd/needle3-val.cact
python3 -I scripts/needle-eval.py --engine "$N/macos-arm64/needle" --model .cache/models/cmd/needle3-val.cact \
  --test "$ROWS/test.jsonl" --json "$N/eval-val.json"
# Optional: questions the app answers by its own rules (time, battery, timer ops, ...): Needle must answer or stay out, never act.
if [ -s "$ROWS/test-rules.jsonl" ]; then
  for m in needle3 needle3-val; do
    python3 -I scripts/needle-eval.py --engine "$N/macos-arm64/needle" --model ".cache/models/cmd/$m.cact" \
      --test "$ROWS/test-rules.jsonl"
  done
fi
