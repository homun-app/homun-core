#!/bin/bash
# =============================================================================
# create-dmg.sh — build Homun.app bundle and wrap it in a .dmg installer
# =============================================================================
#
# Modes of operation (auto-detected from environment):
#
# 1. UNSIGNED (default, no cert available)
#    - Builds Homun.app and Homun-<ver>.dmg
#    - No codesign, no notarization
#    - First launch triggers Gatekeeper warning, user right-click→Open
#
# 2. SIGNED (APPLE_SIGNING_IDENTITY set, typically locally or CI with cert)
#    - Codesigns binary + bundle with hardened runtime
#    - Produces signed .dmg
#    - Still triggers Gatekeeper unless notarized
#
# 3. SIGNED + NOTARIZED (all Apple secrets set — production CI path)
#    - Signs, notarizes via notarytool, staples the ticket
#    - Clean first-launch experience, no Gatekeeper warning
#
# Required env vars:
#   HOMUN_BINARY                  path to pre-built release binary
#   HOMUN_ARCH                    arch label (x64, arm64) for .dmg filename
#
# Optional env vars (enable signing):
#   APPLE_SIGNING_IDENTITY        e.g. "Developer ID Application: Name (TEAMID)"
#
# Optional env vars (enable notarization):
#   APPLE_TEAM_ID                 10-char Team ID
#   APPLE_ID                      Apple ID email
#   APPLE_APP_SPECIFIC_PASSWORD   app-specific password
#
# Output:
#   packaging/macos/build/Homun-<version>-<arch>.dmg
# =============================================================================

set -euo pipefail

cd "$(dirname "$0")"
PACKAGING_DIR="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"
BUILD_DIR="${PACKAGING_DIR}/build"

# Read version from Cargo.toml (rustc-independent to keep this script simple)
VERSION=$(grep -E '^version = ' "${REPO_ROOT}/Cargo.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')
ARCH="${HOMUN_ARCH:-arm64}"

# Resolve binary (passed via env, defaulted for local runs)
HOMUN_BINARY="${HOMUN_BINARY:-${REPO_ROOT}/target/release/homun}"
if [ ! -f "${HOMUN_BINARY}" ]; then
    echo "Error: homun binary not found at ${HOMUN_BINARY}" >&2
    echo "Build it first with: cargo build --release" >&2
    exit 1
fi

echo "========================================================================"
echo "  Homun macOS packaging"
echo "========================================================================"
echo "  Version:  ${VERSION}"
echo "  Arch:     ${ARCH}"
echo "  Binary:   ${HOMUN_BINARY}"
echo "  Build:    ${BUILD_DIR}"
echo "========================================================================"

# Clean previous build
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

# ----------------------------------------------------------------------------
# Step 1 — Assemble Homun.app bundle
# ----------------------------------------------------------------------------
APP_DIR="${BUILD_DIR}/Homun.app"
APP_CONTENTS="${APP_DIR}/Contents"
APP_MACOS="${APP_CONTENTS}/MacOS"
APP_RESOURCES="${APP_CONTENTS}/Resources"

mkdir -p "${APP_MACOS}" "${APP_RESOURCES}"

# Info.plist with version substituted
sed "s|@@VERSION@@|${VERSION}|g" "${PACKAGING_DIR}/Info.plist.template" \
    > "${APP_CONTENTS}/Info.plist"

# Copy binary and launcher
cp "${HOMUN_BINARY}" "${APP_MACOS}/homun"
chmod +x "${APP_MACOS}/homun"

cp "${PACKAGING_DIR}/homun-launcher" "${APP_MACOS}/homun-launcher"
chmod +x "${APP_MACOS}/homun-launcher"

# Icon (optional — falls back to generic app icon if missing)
if [ -f "${PACKAGING_DIR}/homun.icns" ]; then
    cp "${PACKAGING_DIR}/homun.icns" "${APP_RESOURCES}/homun.icns"
else
    echo "Note: packaging/macos/homun.icns not found — bundle will use generic icon"
fi

echo "✓ Assembled Homun.app"

# ----------------------------------------------------------------------------
# Step 2 — Codesign (conditional)
# ----------------------------------------------------------------------------
SIGNED=false
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
    echo "--- Signing ---"
    echo "  Identity: ${APPLE_SIGNING_IDENTITY}"

    # Sign the inner binary first, then the launcher, then the bundle.
    # --options runtime enables the "hardened runtime" required by notarization.
    codesign --force --options runtime --timestamp \
        --sign "${APPLE_SIGNING_IDENTITY}" \
        "${APP_MACOS}/homun"

    codesign --force --options runtime --timestamp \
        --sign "${APPLE_SIGNING_IDENTITY}" \
        "${APP_MACOS}/homun-launcher"

    codesign --force --options runtime --timestamp \
        --sign "${APPLE_SIGNING_IDENTITY}" \
        "${APP_DIR}"

    # Verify
    codesign --verify --deep --strict --verbose=2 "${APP_DIR}"
    spctl --assess --type execute --verbose "${APP_DIR}" || \
        echo "⚠️  spctl assessment failed — likely needs notarization (continuing)"

    SIGNED=true
    echo "✓ Bundle signed"
else
    echo "--- Signing skipped (APPLE_SIGNING_IDENTITY not set) ---"
fi

# ----------------------------------------------------------------------------
# Step 3 — Build the .dmg
# ----------------------------------------------------------------------------
echo "--- Building .dmg ---"
DMG_NAME="Homun-${VERSION}-${ARCH}.dmg"
DMG_PATH="${BUILD_DIR}/${DMG_NAME}"
DMG_STAGING="${BUILD_DIR}/dmg-staging"

rm -rf "${DMG_STAGING}"
mkdir -p "${DMG_STAGING}"
cp -R "${APP_DIR}" "${DMG_STAGING}/"

# Symlink to /Applications so users can drag-drop
ln -s /Applications "${DMG_STAGING}/Applications"

# Use hdiutil to build a compressed UDZO .dmg
hdiutil create \
    -volname "Homun ${VERSION}" \
    -srcfolder "${DMG_STAGING}" \
    -ov -format UDZO \
    "${DMG_PATH}"

rm -rf "${DMG_STAGING}"
echo "✓ Built ${DMG_NAME}"

# ----------------------------------------------------------------------------
# Step 4 — Sign the .dmg itself (conditional)
# ----------------------------------------------------------------------------
if [ "${SIGNED}" = "true" ]; then
    codesign --force --sign "${APPLE_SIGNING_IDENTITY}" "${DMG_PATH}"
    echo "✓ .dmg signed"
fi

# ----------------------------------------------------------------------------
# Step 5 — Notarize (conditional)
# ----------------------------------------------------------------------------
if [ "${SIGNED}" = "true" ] \
   && [ -n "${APPLE_ID:-}" ] \
   && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] \
   && [ -n "${APPLE_TEAM_ID:-}" ]; then
    echo "--- Notarizing ---"
    xcrun notarytool submit "${DMG_PATH}" \
        --apple-id "${APPLE_ID}" \
        --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
        --team-id "${APPLE_TEAM_ID}" \
        --wait

    echo "--- Stapling ---"
    xcrun stapler staple "${DMG_PATH}"

    # Verify stapling
    xcrun stapler validate "${DMG_PATH}"
    spctl --assess --type open --context context:primary-signature --verbose "${DMG_PATH}"
    echo "✓ Notarized + stapled"
else
    echo "--- Notarization skipped (Apple credentials not set) ---"
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
echo "========================================================================"
echo "  Build complete"
echo "========================================================================"
echo "  Output:   ${DMG_PATH}"
ls -lh "${DMG_PATH}"
echo "========================================================================"
