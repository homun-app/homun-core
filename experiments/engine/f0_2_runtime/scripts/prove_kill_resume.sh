#!/usr/bin/env bash
# Prove F0.2: typed plan → human wait → kill → resume → contribution → effect.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="${ROOT}/.venv/bin/python"
WF="f0-2-catalog-prove"
export PYTHONPATH="${ROOT}/src${PYTHONPATH:+:$PYTHONPATH}"
export PYDANTIC_AI_NO_BANNER=1

echo "== reset =="
"$PY" -m f0_2_runtime reset

echo "== start workflow in background =="
"$PY" -m f0_2_runtime start --workflow-id "$WF" --wait >"$ROOT/.data/start.log" 2>&1 &
START_PID=$!
echo "pid=$START_PID"

for i in $(seq 1 60); do
  if [[ -f "$ROOT/.data/last_plan.json" ]]; then
    echo "plan written after ${i} checks"
    break
  fi
  sleep 0.25
done

if [[ ! -f "$ROOT/.data/last_plan.json" ]]; then
  echo "FAIL: plan was not checkpointed before kill" >&2
  kill "$START_PID" 2>/dev/null || true
  exit 1
fi

echo "== plan =="
cat "$ROOT/.data/last_plan.json"
echo

echo "== kill while waiting for contribution =="
kill "$START_PID"
wait "$START_PID" 2>/dev/null || true
sleep 0.5

echo "== resume host + contribute =="
"$PY" -m f0_2_runtime contribute --workflow-id "$WF" --material fixtures/listino.txt --wait-result

echo "== receipts =="
"$PY" -m f0_2_runtime receipts

echo "PASS: kill/resume contribution completed"
