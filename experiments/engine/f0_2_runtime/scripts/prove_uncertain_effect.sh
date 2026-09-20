#!/usr/bin/env bash
# Prove uncertain external effect: write receipt, crash step, retry reconciles once.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="${ROOT}/.venv/bin/python"
WF="f0-2-uncertain-prove"
CMD="cmd_uncertain_1"
export PYTHONPATH="${ROOT}/src${PYTHONPATH:+:$PYTHONPATH}"
export PYDANTIC_AI_NO_BANNER=1

echo "== reset =="
"$PY" -m f0_2_runtime reset

echo "== start with crash-after-effect and wait for completion =="
"$PY" -m f0_2_runtime start --workflow-id "$WF" --command-id "$CMD" --crash-after-effect --wait \
  >"$ROOT/.data/uncertain-start.log" 2>&1 &
START_PID=$!

for i in $(seq 1 80); do
  if [[ -f "$ROOT/.data/last_plan.json" ]]; then
    break
  fi
  sleep 0.25
done

"$PY" -m f0_2_runtime contribute --workflow-id "$WF" --material fixtures/listino.txt --wait-result \
  | tee "$ROOT/.data/uncertain-contribute.log"

kill "$START_PID" 2>/dev/null || true
wait "$START_PID" 2>/dev/null || true

echo "== receipts =="
"$PY" -m f0_2_runtime receipts
COUNT="$("$PY" -c "from pathlib import Path; print(len(list(Path('.data/receipts').glob('*.json'))))")"
if [[ "$COUNT" != "1" ]]; then
  echo "FAIL: expected exactly one receipt, got $COUNT" >&2
  exit 1
fi

if ! grep -q 'reconciled\|applied' "$ROOT/.data/uncertain-contribute.log"; then
  echo "FAIL: missing effect status in contribute output" >&2
  exit 1
fi

echo "PASS: uncertain effect reconciled to a single receipt"
