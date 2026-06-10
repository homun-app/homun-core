#!/usr/bin/env bash
# One-shot: copy the read-only project into a writable workdir (excluding heavy /
# noise trees), build the code knowledge graph with tree-sitter (no LLM via
# --no-cluster), and hand graph.json out. The user's source at /src is never written.
set -euo pipefail

SRC="/src"
WORK="/work"
OUT="/out"

mkdir -p "$WORK" "$OUT"

# Mirror the project, skipping things that aren't source (and Graphify's own output).
rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='target' \
  --exclude='.venv' \
  --exclude='venv' \
  --exclude='dist' \
  --exclude='build' \
  --exclude='__pycache__' \
  --exclude='graphify-out' \
  "$SRC"/ "$WORK"/

# Code-only graph: deterministic tree-sitter, no LLM, no network.
graphify update "$WORK" --no-cluster

# Hand the graph out (the only thing that leaves the container).
if [ -f "$WORK/graphify-out/graph.json" ]; then
  cp "$WORK/graphify-out/graph.json" "$OUT/graph.json"
else
  echo "graphify: nessun graph.json prodotto" >&2
  exit 2
fi
