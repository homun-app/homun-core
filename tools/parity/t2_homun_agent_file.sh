#!/usr/bin/env bash
# T2 — Homun: l'agente crea un file nel workspace (agent run + tool + approvazioni).
set -euo pipefail
ENG=http://127.0.0.1:8765
WS=ws_local
ACT='X-Homun-Actor-Id: person_fabio'
CT='Content-Type: application/json'
IMAGE="${1:-alpine:latest}"
EV=/Users/fabio/Projects/Homun/homun2/docs/research/evidence/2026-09-30-parity-reale

PROJ_ID=$(cat /tmp/parity_proj_id)

# 1. work con obiettivo
WORK=$(curl -s -X POST "$ENG/v1/workspaces/$WS/commands" -H "$ACT" -H "$CT" -d '{
  "command_id": "t2-work", "type": "work.create",
  "payload": {"conversation_id": "'"$(cat /tmp/parity_conv_id)"'", "title": "T2 file parity",
    "objective": "Create a file named parity_test.txt in your workspace with the exact content hello parity (no trailing spaces). Then report the exact file path. Do not run any other command."}
}')
WORK_ID=$(echo "$WORK" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["work_id"])')
echo "WORK=$WORK_ID"

# 2. propose run
RUN=$(curl -s -X POST "$ENG/v1/workspaces/$WS/works/$WORK_ID/agent-runs" -H "$ACT" -H "$CT" -d '{
  "command_id": "t2-run", "expected_version": 1, "material_ids": [], "terminal_image": "'"$IMAGE"'"
}')
RUN_ID=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
DIGEST=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["digest"])')
VERSION=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["expected_version"])')
echo "RUN=$RUN_ID digest=${DIGEST:0:16} status=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"

# 3. approve run
curl -s -X POST "$ENG/v1/workspaces/$WS/works/$WORK_ID/agent-runs/$RUN_ID/approve" -H "$ACT" -H "$CT" \
  -d '{"command_id": "t2-approve", "expected_version": '"$VERSION"', "digest": "'"$DIGEST"'"}' > /dev/null
echo "approved"

# 4. poll: stato run + terminal jobs pending
for i in $(seq 1 60); do
  sleep 3
  RUNVIEW=$(curl -s "$ENG/v1/workspaces/$WS/works/$WORK_ID/agent-runs" -H "$ACT")
  STATUS=$(echo "$RUNVIEW" | python3 -c 'import json,sys; items=json.load(sys.stdin)["items"]; r=[x for x in items if x["id"]=="'"$RUN_ID"'"][0]; print(r["status"])' 2>/dev/null || echo "?")
  # approva eventuali terminal job in attesa
  JOBS=$(curl -s "$ENG/v1/workspaces/$WS/works/$WORK_ID/terminal-jobs" -H "$ACT")
  PENDING=$(echo "$JOBS" | python3 -c '
import json,sys
try:
  items=json.load(sys.stdin)["items"]
  print("\n".join(f"{j[\"id\"]} {j.get(\"status\")} {j.get(\"digest\",\"\")}" for j in items if j.get("status") in ("pending_approval","proposed")))
except Exception as e:
  pass' 2>/dev/null || true)
  if [ -n "$PENDING" ]; then
    while read -r JID JST JDIG; do
      [ -z "$JID" ] && continue
      echo "approving terminal job $JID ($JST)"
      curl -s -X POST "$ENG/v1/workspaces/$WS/works/$WORK_ID/terminal-jobs/$JID/approve" -H "$ACT" -H "$CT" \
        -d '{"digest": "'"$JDIG"'"}' | head -c 200; echo
    done <<< "$PENDING"
  fi
  echo "poll $i: run=$STATUS"
  [ "$STATUS" = "completed" ] && break
  [ "$STATUS" = "failed" ] && break
done

echo "=== FINAL RUN ==="
echo "$RUNVIEW" | python3 -m json.tool > "$EV/t2_homun_run.json"
echo "$RUNVIEW" | python3 -c '
import json,sys
items=json.load(sys.stdin)["items"]
r=[x for x in items if x["id"]=="'"$RUN_ID"'"][0]
print("status:", r["status"])
print("turns:", r.get("turns"), "observations:", len(r.get("observations") or []))
for o in (r.get("observations") or [])[-5:]:
    print("-- obs:", str(o)[:400])
'
echo "WORK_ID=$WORK_ID RUN_ID=$RUN_ID"
