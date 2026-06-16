#!/usr/bin/env bash
# Build + run the contained computer and validate the two properties that make
# the Manus model work — WITHOUT needing a screen:
#   (1) CDP reachable  → the agent can drive a REAL headed browser
#   (2) noVNC reachable → that browser is viewable (to embed in the chat)
#
# Requires the Docker daemon to be running (Docker Desktop started).
set -euo pipefail

IMAGE="homun-contained-computer"
NAME="homun-cc"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Self-host/PaaS: join the gateway's Docker network so the gateway (itself a
# sibling container) can reach this one by name (e.g. http://homun-cc:9222).
# Empty on desktop, where the published loopback ports are used instead.
NETWORK="${HOMUN_CC_NETWORK:-}"
# Host the validation probes hit: 127.0.0.1 on desktop (published ports); the
# container name on a shared network (HOMUN_CC_VALIDATE_HOST=homun-cc).
CC_HOST="${HOMUN_CC_VALIDATE_HOST:-127.0.0.1}"

if ! docker version >/dev/null 2>&1; then
  echo "Docker daemon not reachable — start Docker Desktop, then re-run." >&2
  exit 1
fi

echo "==> building ${IMAGE}"
docker build -t "${IMAGE}" "${HERE}"

echo "==> (re)starting ${NAME}"
docker rm -f "${NAME}" >/dev/null 2>&1 || true
# Generated-file output dir: a real HOST folder bind-mounted at /home/agent/output
# so skill artifacts (xlsx/pdf/…) persist on disk and are listed/downloadable.
ARTIFACTS_DIR="${HOMUN_ARTIFACTS_DIR:-$HOME/.homun/artifacts}"
mkdir -p "${ARTIFACTS_DIR}"
# Publish to loopback only. --shm-size avoids Chromium crashes on small /dev/shm.
# Port 9100→9000: on-device Whisper STT server. Named volume persists the model
# download (~/.cache) across the --rm container lifecycle.
# TZ: the gateway passes the user's effective IANA zone (HOMUN_TZ); default UTC.
# Combined with tzdata in the image, this anchors the container clock — and
# Chromium's `new Date()` — to the user, so date-defaulting web forms don't pick
# the wrong day near the UTC midnight boundary.
TZ_NAME="${HOMUN_TZ:-UTC}"
docker run -d --rm --name "${NAME}" \
  ${NETWORK:+--network "${NETWORK}"} \
  --shm-size=512m \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m,mode=1777 \
  -e TZ="${TZ_NAME}" \
  -p 127.0.0.1:9222:9222 \
  -p 127.0.0.1:6080:6080 \
  -p 127.0.0.1:9100:9000 \
  -v homun-whisper-cache:/home/agent/.cache \
  -v "${ARTIFACTS_DIR}":/home/agent/output \
  "${IMAGE}"

echo "==> validating CDP (real browser reachable)"
CDP_OK=""
for _ in $(seq 1 60); do
  if curl -fsS "http://${CC_HOST}:9222/json/version" >/tmp/cc_cdp.json 2>/dev/null; then CDP_OK=1; break; fi
  sleep 0.5
done
if [ -n "${CDP_OK}" ]; then
  echo "    CDP up: $(cat /tmp/cc_cdp.json)"
else
  echo "    CDP NOT reachable" >&2
fi

echo "==> validating noVNC (live view serveable)"
if curl -fsS -o /dev/null -w "%{http_code}\n" "http://${CC_HOST}:6080/vnc.html" 2>/dev/null | grep -q 200; then
  echo "    noVNC up at http://${CC_HOST}:6080/vnc.html"
else
  echo "    noVNC NOT reachable" >&2
fi

echo
echo "Integration: point the browser sidecar at this CDP endpoint, e.g."
echo "  export BROWSER_AUTOMATION_USER_CDP_ENDPOINT=http://127.0.0.1:9222"
echo "  (sidecar session_manager.ts:482 connectOverCDP attaches — automation port unchanged)"
echo "Stop with: docker rm -f ${NAME}"
