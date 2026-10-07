#!/usr/bin/env bash
# T2 — Homun: l'agente crea un file nel workspace (agent run + tool + approvazioni).
# Uso: t2_homun_agent_file.sh [immagine-pinned-sha256]
set -euo pipefail
ENG=http://127.0.0.1:8765
WS=ws_local
ACT='X-Homun-Actor-Id: person_fabio'
CT='Content-Type: application/json'
IMAGE="${1:?immagine terminal pinned: sha256:<digest>}"
EV="${T2_EVIDENCE:-/tmp/t2_homun_run.json}"
STAMP=$(date +%s)

PROJ_ID=$(cat /tmp/parity_proj_id)
CONV_ID=$(cat /tmp/parity_conv_id)

# 1. work con obiettivo
WORK=$(curl -s -X POST "$ENG/v1/workspaces/$WS/commands" -H "$ACT" -H "$CT" -d "{
  \"command_id\": \"t2-work-$STAMP\", \"type\": \"work.create\",
  \"payload\": {\"conversation_id\": \"$CONV_ID\", \"title\": \"T2 file parity\",
    \"objective\": \"Create a file named parity_test.txt in your workspace with the exact content hello parity (no trailing spaces). Then report the exact file path. Do not run any other command.\"}
}")
WORK_ID=$(echo "$WORK" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("result",d).get("work_id") or d)')
echo "WORK=$WORK_ID"

# 2. propose run
RUN=$(curl -s -X POST "$ENG/v1/workspaces/$WS/works/$WORK_ID/agent-runs" -H "$ACT" -H "$CT" -d "{
  \"command_id\": \"t2-run-$STAMP\", \"expected_version\": 1, \"material_ids\": [],
  \"terminal_image\": \"$IMAGE\"
}")
RUN_ID=$(echo "$RUN" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or d.get("result",{}).get("id") or d)')
DIGEST=$(echo "$RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["digest"])')
echo "RUN=$RUN_ID digest=${DIGEST:0:16}"

# 3. approve run
APPROVE=$(curl -s -X POST "$ENG/v1/workspaces/$WS/works/$WORK_ID/agent-runs/$RUN_ID/approve" -H "$ACT" -H "$CT" \
  -d "{\"command_id\": \"t2-approve-$STAMP\", \"expected_version\": 2, \"digest\": \"$DIGEST\"}")
echo "approve: $(echo "$APPROVE" | head -c 120)"

# 4. poll: stato run + terminal jobs pending
for i in $(seq 1 60); do
  sleep 3
  RUNVIEW=$(curl -s "$ENG/v1/workspaces/$WS/works/$WORK_ID/agent-runs" -H "$ACT")
  STATUS=$(echo "$RUNVIEW" | python3 -c 'import json,sys; items=json.load(sys.stdin)["items"]; print([x for x in items if x["id"]=="'"$RUN_ID"'"][0]["status"])' 2>/dev/null || echo "?")
  for KIND in terminal-jobs file-edits; do
    PENDING=$(curl -s "$ENG/v1/workspaces/$WS/works/$WORK_ID/$KIND" -H "$ACT" | python3 -c '
import json,sys
try:
  items=json.load(sys.stdin)["items"]
  print("\n".join(f"{j[\"id\"]} pending {j.get(\"digest\",\"\")}" for j in items if j.get("status") in ("pending_approval","proposed")))
except Exception:
  pass' 2>/dev/null || true)
    if [ -n "$PENDING" ]; then
      while read -r JID _ JDIG; do
        [ -z "${JID:-}" ] && continue
        echo "approving $KIND $JID"
        curl -s -X POST "$ENG/v1/workspaces/$WS/works/$WORK_ID/$KIND/$JID/approve" -H "$ACT" -H "$CT" \
          -d "{\"digest\": \"$JDIG\"}" | head -c 150; echo
      done <<< "$PENDING"
    fi
  done
  echo "poll $i: run=$STATUS"
  [ "$STATUS" = "completed" ] && break
  [ "$STATUS" = "failed" ] && break
done

echo "=== FINAL RUN ==="
echo "$RUNVIEW" | python3 -m json.tool > "$EV"
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
