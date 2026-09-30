#!/usr/bin/env bash
# T6 — Homun: esecuzione terminale con approvazione digest (H09).
set -euo pipefail
ENG=http://127.0.0.1:8765
WS=ws_local
ACT='X-Homun-Actor-Id: person_fabio'
CT='Content-Type: application/json'
IMAGE='sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6'
CMD='echo HERMES-TERM-OK > term_test.txt'

WORK=$(curl -s -X POST "$ENG/v1/workspaces/$WS/commands" -H "$ACT" -H "$CT" -d '{
  "command_id": "t6-work", "type": "work.create",
  "payload": {"conversation_id": "'"$(cat /tmp/parity_conv_id)"'", "title": "T6 terminal parity",
    "objective": "Use terminal_execute exactly once to run this exact command: '"$CMD"'. Then report the exit code and finish."}
}')
W=$(echo "$WORK" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["work_id"])')
echo "W=$W"
RUN=$(curl -s -X POST "$ENG/v1/workspaces/$WS/works/$W/agent-runs" -H "$ACT" -H "$CT" -d '{
  "command_id": "t6-run", "expected_version": 1, "material_ids": [], "terminal_image": "'"$IMAGE"'" }')
RID=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
DG=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["digest"])')
EV=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["expected_version"])')
curl -s -X POST "$ENG/v1/workspaces/$WS/works/$W/agent-runs/$RID/approve" -H "$ACT" -H "$CT" \
  -d '{"command_id":"t6-ap","expected_version":'"$EV"',"digest":"'"$DG"'"}' > /dev/null
echo "run approved $RID"

for i in $(seq 1 60); do
  sleep 3
  RV=$(curl -s "$ENG/v1/workspaces/$WS/works/$W/agent-runs" -H "$ACT")
  S=$(echo "$RV" | python3 -c 'import json,sys; items=json.load(sys.stdin)["items"]; print([x for x in items if x["id"]=="'"$RID"'"][0]["status"])' 2>/dev/null || echo "?")
  # approva terminal job pending
  curl -s "$ENG/v1/workspaces/$WS/works/$W/terminal-jobs" -H "$ACT" | python3 -c '
import json,sys
try:
    for j in json.load(sys.stdin)["items"]:
        if j.get("status")=="pending_approval":
            print(j["id"], j["digest"])
except Exception: pass' > /tmp/t6_pending
  while read -r JID JDIG; do
    [ -z "${JID:-}" ] && continue
    echo "approving terminal $JID"
    curl -s -X POST "$ENG/v1/workspaces/$WS/works/$W/terminal-jobs/$JID/approve" -H "$ACT" -H "$CT" -d '{"digest":"'"$JDIG"'"}' | head -c 150; echo
  done < /tmp/t6_pending
  [ "$S" = "completed" ] || [ "$S" = "failed" ] && { echo "final=$S"; break; }
done
echo "$RV" | python3 -c '
import json,sys
r=[x for x in json.load(sys.stdin)["items"] if x["id"]=="'"$RID"'"][0]
print("status:",r["status"],"turns:",r.get("turns"))
for o in (r.get("observations") or [])[-3:]: print("--",o.get("tool"),":",json.dumps(o.get("result"),ensure_ascii=False)[:200])
'
echo "W=$W" > /tmp/parity_w6
