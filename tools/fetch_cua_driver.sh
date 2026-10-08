#!/usr/bin/env bash
# Scarica cua-driver con l'installer upstream, versione pinata.
#
# Uso: fetch_cua_driver.sh [versione]
#   - versione: tag di rilascio (es. 0.5.0); "latest" o assente = ultima.
#   Stampa su stdout il percorso del binario installato e il suo sha256 su
#   stderr, pronto per il build-receipt del bundle.
#
# Scarica-prima-esegui (niente curl|bash): niente shell injection, lo script
# finisce in un mktemp 0600. Entrambi gli installer upstream onorano
# CUA_DRIVER_RS_VERSION rispetto al default impostato.
set -euo pipefail

VERSION="${1:-latest}"
SH_URL="https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh"

script="$(mktemp)"
trap 'rm -f "$script"' EXIT
curl -fsSL -o "$script" "$SH_URL"
if [ "$VERSION" != "latest" ]; then
  export CUA_DRIVER_RS_VERSION="$VERSION"
fi
# l'installer stampa istruzioni informative: su stdout dev'esserci SOLO il
# percorso del binario (il chiamante lo cattura e lo scrive in GITHUB_OUTPUT)
/bin/bash "$script" >&2

for candidate in \
  "$HOME/.local/bin/cua-driver" \
  /opt/homebrew/bin/cua-driver \
  /usr/local/bin/cua-driver \
  /usr/bin/cua-driver
do
  if [ -x "$candidate" ]; then
    sha="$(shasum -a 256 "$candidate" | cut -d' ' -f1)"
    echo "cua-driver $VERSION sha256=$sha" >&2
    echo "$candidate"
    exit 0
  fi
done
if command -v cua-driver >/dev/null 2>&1; then
  path="$(command -v cua-driver)"
  sha="$(shasum -a 256 "$path" | cut -d' ' -f1)"
  echo "cua-driver $VERSION sha256=$sha" >&2
  echo "$path"
  exit 0
fi
echo "cua-driver: installato ma non trovato nei percorsi noti" >&2
exit 1
