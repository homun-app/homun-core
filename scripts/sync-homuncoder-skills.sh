#!/usr/bin/env bash
# HomunCoder: installs the CoderSteroids (evidence-first-methodology) skills into
# Homun's skill directory so they're scanned and usable in chats. The methodology repo
# stays the source of truth — re-run this after updating it.
#
# Usage: scripts/sync-homuncoder-skills.sh [path-to-evidence-first-methodology]
set -euo pipefail

SRC="${1:-/Users/fabio/Projects/superdev/evidence-first-methodology}"
SKILLS_SRC="$SRC/skills"
DEST="${LOCAL_FIRST_DATA_DIR:-$HOME/.local-first-personal-assistant}/skills"

if [[ ! -d "$SKILLS_SRC" ]]; then
  echo "✗ skill sorgente non trovate: $SKILLS_SRC" >&2
  echo "  passa il path del repo evidence-first-methodology come primo argomento." >&2
  exit 1
fi

mkdir -p "$DEST"
count=0
: > "$DEST/homuncoder-skills.txt"
for dir in "$SKILLS_SRC"/*/; do
  [[ -f "${dir}SKILL.md" ]] || continue
  id="$(basename "$dir")"
  rm -rf "${DEST:?}/$id"
  cp -R "$dir" "$DEST/$id"
  echo "$id" >> "$DEST/homuncoder-skills.txt"
  count=$((count + 1))
done

echo "✓ HomunCoder: installate $count skill in $DEST"
echo "  manifest: $DEST/homuncoder-skills.txt"
ls "$DEST" | sed 's/^/  • /'
