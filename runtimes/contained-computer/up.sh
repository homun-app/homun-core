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

# Stamp the image with a hash of its definition (Dockerfile + entrypoint) so the app
# can tell a stale running container (built from an older version) from a fresh one
# and rebuild it on update. The gateway passes HOMUN_CC_HASH (its own computed value);
# a manual run computes the SAME hash (sha256 of the two files, first 16 hex) so both
# agree and we never recycle needlessly.
# Hash ALL files baked into the image (everything COPY'd), not just the Dockerfile —
# otherwise a renderer change (deck_render.py) wouldn't trigger a rebuild and the
# container would keep an old copy. MUST stay in sync with the gateway's
# contained_computer_def_hash().
HASH_FILES="Dockerfile entrypoint.sh deck_render.py deck_qa.py doc_render.py design_tokens.py whisper_server.py novnc-view.html"
if [ -z "${HOMUN_CC_HASH:-}" ]; then
  HASH_PATHS=""
  for f in ${HASH_FILES}; do HASH_PATHS="${HASH_PATHS} ${HERE}/${f}"; done
  if command -v shasum >/dev/null 2>&1; then
    HOMUN_CC_HASH="$(cat ${HASH_PATHS} 2>/dev/null | shasum -a 256 | cut -c1-16)"
  elif command -v sha256sum >/dev/null 2>&1; then
    HOMUN_CC_HASH="$(cat ${HASH_PATHS} 2>/dev/null | sha256sum | cut -c1-16)"
  else
    HOMUN_CC_HASH="unknown"
  fi
fi
# Docker's layer cache is content-correct (a changed COPY'd file rebuilds only its
# layer), so rebuilds stay fast. Set HOMUN_CC_NO_CACHE=1 to force a clean rebuild.
NO_CACHE=""
[ -n "${HOMUN_CC_NO_CACHE:-}" ] && NO_CACHE="--no-cache"
# Freshness: opportunistically refresh the base image so a Debian security/point update
# cascades into a rebuilt apt layer (a newer `chromium`) instead of Docker's frozen cache.
# Deliberately NON-fatal and skippable (HOMUN_CC_NO_PULL=1): an offline boot falls back to
# the already-cached base + layers (so autostart-at-boot never breaks without a network).
# The tag MUST match the Dockerfile `FROM`.
BASE_IMAGE="debian:trixie-slim"
if [ -z "${HOMUN_CC_NO_PULL:-}" ] && [ -z "${NO_CACHE}" ]; then
  if docker pull "${BASE_IMAGE}" >/dev/null 2>&1; then
    echo "==> base image ${BASE_IMAGE} refreshed"
  else
    echo "==> base pull skipped (offline or unchanged) — using cached image"
  fi
fi
echo "==> building ${IMAGE} (def hash ${HOMUN_CC_HASH})${NO_CACHE:+ [no-cache]}"
docker build ${NO_CACHE} --label "homun.cc_hash=${HOMUN_CC_HASH}" -t "${IMAGE}" "${HERE}"

echo "==> (re)starting ${NAME}"
docker rm -f "${NAME}" >/dev/null 2>&1 || true
# Generated-file output dir: a real HOST folder bind-mounted at /home/agent/output
# so skill artifacts (xlsx/pdf/…) persist on disk and are listed/downloadable.
ARTIFACTS_DIR="${HOMUN_ARTIFACTS_DIR:-$HOME/.homun/artifacts}"
mkdir -p "${ARTIFACTS_DIR}"
# Browser profile dir, bind-mounted at /data/profile (Chromium's --user-data-dir).
# This is the contained-computer's REAL browser profile (openclaw model: drive a
# genuine headed browser, not a synthetic one). Persisting it keeps cookies/logins
# across recycles — right for authenticated use, and the stealth comes from being a
# real headed browser, not from a fingerprint trick.
#
# Escape hatch: a persistent profile that an anti-bot vendor flags once stays flagged
# (the poisoning that blocks anonymous flight/train searches). HOMUN_CC_RESET_PROFILE=1
# wipes it on the next `up` so a flagged identity can be cleanly recovered without
# losing the model/artifact volumes.
CC_PROFILE_DIR="${HOMUN_CC_PROFILE_DIR:-$HOME/.homun/cc-profile}"
if [ "${HOMUN_CC_RESET_PROFILE:-0}" = "1" ]; then
  echo "==> HOMUN_CC_RESET_PROFILE=1 -> resetting ${CC_PROFILE_DIR} (fresh, unflagged profile)"
  rm -rf "${CC_PROFILE_DIR}"
fi
mkdir -p "${CC_PROFILE_DIR}"
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
  -v "${CC_PROFILE_DIR}":/data/profile \
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
