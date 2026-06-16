#!/usr/bin/env bash
# Snapshot the installed HomunCoder methodology skills into the repo so they ship
# with every build (bundled by prepare-package.mjs + the Dockerfile, then seeded
# into HOMUN_DATA_DIR/skills on first run by the gateway).
#
# Source of truth stays the external methodology repo. Workflow to refresh:
#   1. scripts/sync-homuncoder-skills.sh [path-to-evidence-first-methodology]
#      → installs the filtered + rebranded skills into ~/.homun/skills
#   2. scripts/vendor-default-skills.sh
#      → copies that processed set (per the manifest) into resources/default-skills
#   3. commit resources/default-skills
#
# This two-step keeps the filter/rebrand logic in ONE place (the sync script) and
# vendors only its output — no duplicated transforms here.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${HOMUN_DATA_DIR:-$HOME/.homun}/skills"
DEST="$HERE/resources/default-skills"
MANIFEST="$SRC/homuncoder-skills.txt"

if [[ ! -f "$MANIFEST" ]]; then
  echo "✗ manifest non trovato: $MANIFEST" >&2
  echo "  esegui prima scripts/sync-homuncoder-skills.sh" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$MANIFEST" "$DEST/homuncoder-skills.txt"

count=0
while read -r id; do
  [[ -z "$id" ]] && continue
  if [[ -d "$SRC/$id" ]]; then
    cp -R "$SRC/$id" "$DEST/$id"
    count=$((count + 1))
  else
    echo "  ⚠ skill nel manifest ma assente: $id" >&2
  fi
done < "$MANIFEST"

# Guard: the rebrand must already be applied in the source — fail loudly if not.
if grep -rl "CoderSteroids" "$DEST" >/dev/null 2>&1; then
  echo "✗ residuo 'CoderSteroids' nello snapshot — la sync non ha rebrandizzato." >&2
  exit 1
fi

echo "✓ vendorizzate $count skill in resources/default-skills"
echo "  commit la cartella per distribuirle di default."
