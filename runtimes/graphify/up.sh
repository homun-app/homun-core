#!/usr/bin/env bash
# Build (lazily) the Graphify image and run a ONE-SHOT code-graph extraction on a
# project, writing graph.json into a gateway-managed output dir. The user's repo is
# mounted READ-ONLY and never modified. Network is disabled at run time (local-first).
# A watchdog hard-stops the container after a timeout so a pathological tree can never
# run forever (the graph.json on the mounted /out survives a successful run).
#
#   up.sh <project-dir> <out-dir>
#
# Requires the Docker daemon running (Docker Desktop). The gateway ensures that.
set -euo pipefail

IMAGE="homun-graphify"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMEOUT="${GRAPHIFY_TIMEOUT_SECS:-240}"

PROJECT="${1:?uso: up.sh <project-dir> <out-dir>}"
OUT="${2:?uso: up.sh <project-dir> <out-dir>}"

if ! docker version >/dev/null 2>&1; then
  echo "Docker daemon non raggiungibile — avvia Docker Desktop, poi riprova." >&2
  exit 1
fi

# Always build: Docker's layer cache makes this ~instant when nothing changed, and
# it guarantees a stale image (e.g. after editing entrypoint.sh's exclusions) is never
# silently reused — the lazy "only if missing" build was a real footgun.
docker build -t "$IMAGE" "$HERE" >&2

mkdir -p "$OUT"
NAME="homun-graphify-$$-$RANDOM"

# Detached, named run so a watchdog can hard-stop it on timeout. Read-only source
# mount + writable out mount; no network during extraction.
docker run -d --name "$NAME" --network none \
  --memory="${GRAPHIFY_MEMORY:-6g}" --memory-swap="${GRAPHIFY_MEMORY:-6g}" \
  -v "$PROJECT":/src:ro \
  -v "$OUT":/out \
  "$IMAGE" >/dev/null

# Watchdog: force-remove the container if it outlives the timeout.
( sleep "$TIMEOUT"; docker rm -f "$NAME" >/dev/null 2>&1 ) &
WATCH=$!

# Block until the container exits (normally, or killed by the watchdog).
docker wait "$NAME" >/dev/null 2>&1 || true
kill "$WATCH" >/dev/null 2>&1 || true
docker logs "$NAME" >&2 2>&1 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true
