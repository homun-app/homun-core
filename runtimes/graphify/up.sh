#!/usr/bin/env bash
# Build (lazily) the Graphify image and run a ONE-SHOT code-graph extraction on a
# project, writing graph.json into a gateway-managed output dir. The user's repo is
# mounted READ-ONLY and never modified. Network is disabled at run time (local-first).
#
#   up.sh <project-dir> <out-dir>
#
# Requires the Docker daemon running (Docker Desktop). The gateway ensures that.
set -euo pipefail

IMAGE="homun-graphify"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT="${1:?uso: up.sh <project-dir> <out-dir>}"
OUT="${2:?uso: up.sh <project-dir> <out-dir>}"

if ! docker version >/dev/null 2>&1; then
  echo "Docker daemon non raggiungibile — avvia Docker Desktop, poi riprova." >&2
  exit 1
fi

# Lazy build: only when the image is missing (build needs network for pip; run does not).
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> building ${IMAGE}" >&2
  docker build -t "$IMAGE" "$HERE" >&2
fi

mkdir -p "$OUT"

# Read-only source mount + writable out mount; no network during extraction.
docker run --rm --network none \
  -v "$PROJECT":/src:ro \
  -v "$OUT":/out \
  "$IMAGE"
