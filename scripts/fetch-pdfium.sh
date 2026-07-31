#!/usr/bin/env bash
# Backwards-compatible setup entry point. The Node implementation owns the
# pinned release, SHA-256 verification, platform mapping, and legal notices used
# by both development and packaged builds.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${ROOT}/apps/desktop/scripts/pdfium-runtime.mjs" \
  --destination "${HOME}/.homun/pdfium"
