#!/usr/bin/env bash
# Invia un comando al motore Homun (dev-insecure, actor person_fabio).
# Uso: homun_cmd.sh <command_id> <type> <payload-json>
set -euo pipefail
CMD_ID="${1:?command_id}"
TYPE="${2:?type}"
PAYLOAD="${3:-\{\}}"
curl -s -X POST http://127.0.0.1:8765/v1/workspaces/ws_local/commands \
  -H 'Content-Type: application/json' \
  -H 'X-Homun-Actor-Id: person_fabio' \
  -d "{\"command_id\": \"$CMD_ID\", \"type\": \"$TYPE\", \"payload\": $PAYLOAD}"
