#!/usr/bin/env bash
# Build + run the contained computer and validate the two properties that make
# the Manus model work — WITHOUT needing a screen:
#   (1) CDP reachable  → the agent can drive a REAL headed browser
#   (2) noVNC reachable → that browser is viewable (to embed in the chat)
#
# Requires the Docker daemon to be running (Docker Desktop started).
set -euo pipefail

IMAGE="lfpa-contained-computer"
NAME="lfpa-cc"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! docker version >/dev/null 2>&1; then
  echo "Docker daemon not reachable — start Docker Desktop, then re-run." >&2
  exit 1
fi

echo "==> building ${IMAGE}"
docker build -t "${IMAGE}" "${HERE}"

echo "==> (re)starting ${NAME}"
docker rm -f "${NAME}" >/dev/null 2>&1 || true
# Publish to loopback only. --shm-size avoids Chromium crashes on small /dev/shm.
docker run -d --rm --name "${NAME}" \
  --shm-size=512m \
  -p 127.0.0.1:9222:9222 \
  -p 127.0.0.1:6080:6080 \
  "${IMAGE}"

echo "==> validating CDP (real browser reachable)"
CDP_OK=""
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:9222/json/version >/tmp/cc_cdp.json 2>/dev/null; then CDP_OK=1; break; fi
  sleep 0.5
done
if [ -n "${CDP_OK}" ]; then
  echo "    CDP up: $(cat /tmp/cc_cdp.json)"
else
  echo "    CDP NOT reachable" >&2
fi

echo "==> validating noVNC (live view serveable)"
if curl -fsS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:6080/vnc.html" 2>/dev/null | grep -q 200; then
  echo "    noVNC up at http://127.0.0.1:6080/vnc.html"
else
  echo "    noVNC NOT reachable" >&2
fi

echo
echo "Integration: point the browser sidecar at this CDP endpoint, e.g."
echo "  export BROWSER_AUTOMATION_USER_CDP_ENDPOINT=http://127.0.0.1:9222"
echo "  (sidecar session_manager.ts:482 connectOverCDP attaches — automation port unchanged)"
echo "Stop with: docker rm -f ${NAME}"
