#!/usr/bin/env bash
# cargo-gc.sh — pulizia degli artefatti di build Rust per liberare disco.
#
# Cargo non fa garbage-collection: target/debug/deps accumula versioni vecchie
# a ogni cambio di dipendenza, e target/debug/incremental e' una cache che
# cresce all'infinito. Questo script tiene "solo l'ultima build valida".
#
#   ./scripts/cargo-gc.sh          pulizia LEGGERA (default): rimuove la cache
#                                  rigenerabile (incremental/) e il profilo
#                                  release inutilizzato. Istantanea, NON tocca
#                                  il binario debug ne' la cache delle deps,
#                                  quindi i rebuild restano rapidi.
#
#   ./scripts/cargo-gc.sh --deep   pulizia PROFONDA: `cargo clean` totale +
#                                  rebuild del solo gateway. Azzera anche i
#                                  ~28G di deps stantie. Costa un rebuild
#                                  completo (qualche minuto).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GATEWAY_BIN="target/debug/local-first-desktop-gateway"

size() { du -sh "$1" 2>/dev/null | cut -f1; }
echo "target/ prima: $(size target)   (disco libero: $(df -h . | awk 'NR==2{print $4}'))"

if [[ "${1:-}" == "--deep" ]]; then
  echo "→ pulizia PROFONDA: cargo clean + rebuild gateway"
  cargo clean
  echo "→ rebuild del solo gateway (le altre build si rigenerano on-demand)..."
  cargo build -p local-first-desktop-gateway
else
  echo "→ pulizia LEGGERA: rimuovo incremental/ e release/"
  rm -rf target/debug/incremental target/release
fi

echo "target/ dopo:  $(size target)   (disco libero: $(df -h . | awk 'NR==2{print $4}'))"
if [[ -x "$GATEWAY_BIN" ]]; then
  echo "✓ binario gateway presente: $GATEWAY_BIN"
else
  echo "⚠ binario gateway assente — verra' ricostruito al prossimo avvio (electron:dev) o con: cargo build -p local-first-desktop-gateway"
fi
