#!/usr/bin/env bash
# One-shot: copy the read-only project into a writable workdir (excluding heavy /
# noise trees), build the code knowledge graph with tree-sitter (no LLM via
# --no-cluster), and hand graph.json out. The user's source at /src is never written.
set -euo pipefail

SRC="/src"
WORK="/work"
OUT="/out"

mkdir -p "$WORK" "$OUT"

# Mirror the project, skipping what isn't the user's source:
#  - vendored deps: site-packages (ANY venv, any name), node_modules, target, vendor,
#    egg-info, tool caches — mapping these graphs the stdlib/3rd-party, not the project;
#  - build/output/data dirs; and heavy data files that never yield code nodes (and only
#    slow the copy/walk). The optional SUBPATH lets a huge repo map just one subtree.
rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='site-packages' \
  --exclude='target' \
  --exclude='vendor' \
  --exclude='.venv' \
  --exclude='venv' \
  --exclude='*.egg-info' \
  --exclude='.tox' \
  --exclude='.mypy_cache' \
  --exclude='.pytest_cache' \
  --exclude='.ruff_cache' \
  --exclude='.next' \
  --exclude='coverage' \
  --exclude='dist' \
  --exclude='build' \
  --exclude='__pycache__' \
  --exclude='graphify-out' \
  --exclude='*.csv' --exclude='*.log' --exclude='*.so' --exclude='*.mat' \
  --exclude='*.sav' --exclude='*.db' --exclude='*.dat' --exclude='*.jsonl' \
  --exclude='*.parquet' --exclude='*.lock' \
  --exclude='*.sh' --exclude='*.bash' \
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
