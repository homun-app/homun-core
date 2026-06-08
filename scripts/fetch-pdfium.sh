#!/usr/bin/env bash
# Fetches the pdfium native library (prebuilt by bblanchon/pdfium-binaries) into
# the gateway data dir, where the desktop-gateway resolves it at runtime for PDF
# attachment ingestion (text extraction + page rasterization → vision).
#
# Resolution at runtime: LOCAL_FIRST_PDFIUM_LIB → ~/.local-first-personal-assistant/pdfium → system.
# This script populates the second location. For packaging, the per-OS lib gets
# bundled with the app instead.
set -euo pipefail

DEST="${HOME}/.local-first-personal-assistant/pdfium"
REL="${PDFIUM_RELEASE:-latest/download}"
BASE="https://github.com/bblanchon/pdfium-binaries/releases/${REL}"

os="$(uname -s)"
arch="$(uname -m)"
case "${os}-${arch}" in
  Darwin-arm64) asset="pdfium-mac-arm64.tgz" ;;
  Darwin-x86_64) asset="pdfium-mac-x64.tgz" ;;
  Linux-x86_64) asset="pdfium-linux-x64.tgz" ;;
  Linux-aarch64) asset="pdfium-linux-arm64.tgz" ;;
  *) echo "unsupported platform: ${os}-${arch}" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
echo "Downloading ${asset} …"
curl -fsSL "${BASE}/${asset}" -o "${tmp}/pdfium.tgz"
tar -xzf "${tmp}/pdfium.tgz" -C "${tmp}"

mkdir -p "${DEST}"
# The archive lays the lib under lib/ (libpdfium.dylib / .so) or bin/ (pdfium.dll).
found=""
for cand in lib/libpdfium.dylib lib/libpdfium.so bin/pdfium.dll; do
  if [ -f "${tmp}/${cand}" ]; then
    cp "${tmp}/${cand}" "${DEST}/"
    found="${DEST}/$(basename "${cand}")"
    break
  fi
done

if [ -z "${found}" ]; then
  echo "could not locate the pdfium library inside the archive" >&2
  ls -R "${tmp}" >&2
  exit 1
fi

echo "Installed pdfium → ${found}"
