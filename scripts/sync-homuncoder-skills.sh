#!/usr/bin/env bash
# HomunCoder: installs the evidence-first methodology skills into Homun's skill directory
# so they're scanned and usable in project chats. The methodology repo stays the source of
# truth — re-run this after updating it.
#
# Two transforms happen on the way in (so the source repo stays untouched):
#  1. EXCLUDE — methodology-DEVELOPMENT skills (benchmarking the methodology, authoring/
#     linting skills, exporting to other agents) are NOT installed: they're about building
#     the methodology, not about the user's coding work.
#  2. REBRAND — the visible name "CoderSteroids" is rewritten to "HomunCoder" in the copied
#     files, so Homun shows one consistent name.
#
# Usage: scripts/sync-homuncoder-skills.sh [path-to-evidence-first-methodology]
set -euo pipefail

SRC="${1:-/Users/fabio/Projects/superdev/evidence-first-methodology}"
SKILLS_SRC="$SRC/skills"
DEST="${LOCAL_FIRST_DATA_DIR:-$HOME/.local-first-personal-assistant}/skills"

# Methodology-development skills: kept in the source repo, NOT installed into Homun.
EXCLUDE=(
  benchmark-against-superpowers
  benchmark-runner
  self-improvement-loop
  skill-authoring-pressure-test
  skill-lifecycle-doctor
  cross-agent-export
  project-bootstrap
)
is_excluded() {
  local id="$1"
  for x in "${EXCLUDE[@]}"; do [[ "$x" == "$id" ]] && return 0; done
  return 1
}

if [[ ! -d "$SKILLS_SRC" ]]; then
  echo "✗ skill sorgente non trovate: $SKILLS_SRC" >&2
  echo "  passa il path del repo evidence-first-methodology come primo argomento." >&2
  exit 1
fi

mkdir -p "$DEST"
count=0
skipped=0
: > "$DEST/homuncoder-skills.txt"
for dir in "$SKILLS_SRC"/*/; do
  [[ -f "${dir}SKILL.md" ]] || continue
  id="$(basename "$dir")"
  # Drop any previously-installed copy (so removed/excluded skills disappear on re-sync).
  rm -rf "${DEST:?}/$id"
  if is_excluded "$id"; then
    skipped=$((skipped + 1))
    continue
  fi
  cp -R "$dir" "$DEST/$id"
  # Rebrand the visible name in every copied text file (CoderSteroids → HomunCoder).
  find "$DEST/$id" -type f \( -name '*.md' -o -name '*.txt' -o -name '*.sh' -o -name '*.py' \) \
    -exec sed -i '' 's/CoderSteroids/HomunCoder/g' {} + 2>/dev/null || true
  echo "$id" >> "$DEST/homuncoder-skills.txt"
  count=$((count + 1))
done

echo "✓ HomunCoder: installate $count skill in $DEST (escluse $skipped meta-skill)"
echo "  manifest: $DEST/homuncoder-skills.txt"
