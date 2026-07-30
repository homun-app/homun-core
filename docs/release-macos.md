# Release — macOS (signing + notarization)

Releases are built **in CI** by GitHub Actions, not locally. This doc explains the
pipeline, the secrets, and how to verify a build passes Gatekeeper.

## How releases are built

`.github/workflows/build.yml` ("Build installers"):
- **Ogni run** parte da `Release readiness`: format, Clippy workspace con warning negati,
  audit npm, suite deterministiche complete e RustSec devono essere verdi sullo stesso SHA prima
  che inizi la matrice. Ogni piattaforma produce anche un `SHA256SUMS-<platform>.txt`.
- **Push a `v*` tag** → the tag (minus the `v`) is stamped into `package.json` (single source of
  truth for the version), then mac (arm64) + win + linux installers are built and uploaded to a
  **draft release in the public `homun-releases` repo**. The draft is not visible to downloads or
  auto-update clients until it is explicitly published. Review it with the complete
  [release candidate matrix](testing/release-candidate-matrix.md) before publishing.
- **Run manually** (Actions tab → *Build installers* → *Run workflow*, i.e. `workflow_dispatch`)
  → builds + uploads artifacts only (`--publish never`, no token issued). Use this to verify the
  pipeline before tagging.

> **A tag without `MAC_CSC_LINK` fails on purpose.** The signing-detection step `exit 1`s on a
> `v*` run with no cert, so an *unsigned* macOS build can never reach the public update feed.

Each runner builds its own native gateway (`cargo --release`) and bundles it; an installer is
only valid for the OS/arch that produced it.

## Secrets (already configured on the repo)

| Secret | Used as | Purpose |
|---|---|---|
| `MAC_CSC_LINK` | `CSC_LINK` | Developer ID Application cert (base64 `.p12`) |
| `MAC_CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` | `.p12` password |
| `APPLE_ID` | `APPLE_ID` | notarization (Apple ID) |
| `APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_APP_SPECIFIC_PASSWORD` | notarization |
| `APPLE_TEAM_ID` | `APPLE_TEAM_ID` | notarization |

The mac tag job builds **signed + notarized**
(`electron-builder --mac -c.mac.notarize=true`) when `MAC_CSC_LINK` is non-empty and fails closed
otherwise. Only manual dispatch and pull-request runs may fall back to an unsigned mac artifact.
The presence check runs in a shell step (`steps.signing.outputs.has_cert`) that logs the cert state
explicitly.

> **Status (2026-06-16): working.** Verified end-to-end on run 27623629097 — `signing …
> type=distribution` → `notarization successful` → `Homun-0.1.0-arm64.dmg`. Two issues were
> fixed to get here: `MAC_CSC_LINK` was **empty** (the `.p12` was never actually uploaded), and
> `APPLE_APP_SPECIFIC_PASSWORD` was not a valid app-specific password (notarytool `401`). Both
> secrets are now set correctly. `v0.1.0` (2026-06-14) had shipped an unsigned `.dmg` before
> this fix — cut a new tag for the first signed release.

### Set / fix the signing secrets

```bash
# Developer ID Application cert exported as .p12:
base64 -i DeveloperIDApplication.p12 | gh secret set MAC_CSC_LINK --repo homun-app/homun-core
gh secret set MAC_CSC_KEY_PASSWORD --repo homun-app/homun-core   # then paste the .p12 password
# Notarization (verify these too):
gh secret set APPLE_ID --repo homun-app/homun-core
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo homun-app/homun-core
gh secret set APPLE_TEAM_ID --repo homun-app/homun-core
```
Then re-run: Actions → *Build installers* → *Run workflow* (or push a `v*` tag). The
*Detect macOS signing creds* step will log `Developer ID cert present (... chars)` when it's set.

## Auto-update (electron-updater) — one-time setup

Desktop builds self-update: the app checks a **public** release feed, and the Notifications
view (sidebar bell) shows a **download + restart** card when a newer version is published. The
source repo stays **private** — only the binaries are public.

Two one-time prerequisites:

1. **Create a public repo `homun-app/homun-releases` — initialized, NOT empty.** This is the
   update feed `apps/desktop/package.json` → `build.publish` points at, and what
   electron-updater queries at runtime (no token embedded in the app). It **must have a default
   branch**: an empty repo can't anchor a release tag, so publishing fails with
   `422 Repository is empty` and the release stays "untagged". Create it with `--add-readme`:
   ```bash
   gh repo create homun-app/homun-releases --public --add-readme -d "Homun desktop release binaries"
   ```
2. **Add a `RELEASES_TOKEN` secret** on `homun-core` — a PAT that can write releases to
   `homun-releases` (the default `GITHUB_TOKEN` can't reach another repo). Fine-grained PAT
   scoped to `homun-releases` with **Contents: read/write**, or a classic PAT with `repo`.
   ```bash
   gh secret set RELEASES_TOKEN --repo homun-app/homun-core   # paste the PAT
   ```

After that, every `v*` tag uploads macOS, Windows and Linux installers, update metadata and
SHA-256 manifests to a draft release in `homun-releases`. **Publish that draft** for clients to see
the update (a draft is invisible to electron-updater). The `.yml` files make the update
discoverable; a hand-made release containing only installers would not trigger the client flow.

> Updates only flow **between published releases newer than the running build**. You can't test
> the in-app card until at least one release is published in `homun-releases` and a client is
> running an older version. In dev (`app.isPackaged === false`) the check is a deliberate no-op.

### Platform scope

Auto-update can silently download and **execute** a binary (`quitAndInstall`), so Homun enables
automatic installation only on signed and notarized macOS builds. Windows and Linux clients are
notify-only: they open the release page for a manual download.

- **Windows**: CI attempts Certum SimplySign signing. If signing is unavailable, the workflow may
  place an unsigned download-only EXE in the draft; the release matrix must record that fact.
- **Linux**: AppImage and DEB are unsigned download-only assets. `latest-linux.yml` still provides
  the updater hash, but Homun does not auto-install the binary.

### Versioning (tags drive it)

The git tag **is** the version — CI stamps `package.json` from it (`npm version <tag-minus-v>`).
electron-updater compares **semver**, so each release must be strictly greater than the last.
`0.1.1001`, `0.1.1002`, … is valid semver (patch is unbounded — no need to start high for headroom,
but it works). Keep tag and `package.json` consistent; CI does that for you on tag runs. There's
no need to commit a version bump by hand before tagging — just `git tag vX.Y.Z && git push --tags`.

## The bundled gateway is signed automatically

The app bundles a native Rust gateway at `Contents/Resources/bin/local-first-desktop-gateway`.
electron-builder signs it as part of its normal app signing (confirmed: the CI **Windows** job
also signs `bin/local-first-desktop-gateway.exe`), with the hardened runtime + entitlements from
`build/entitlements.mac.plist`. No extra hook is needed. If a future signed run fails
notarization pointing at the gateway, add it to `mac.binaries` (signs during the keychain-ready
phase — do NOT use an `afterPack` hook, which runs before the keychain exists).

## Configured in `apps/desktop/package.json` → `build`

- `mac`: `dmg` + `zip` (arm64), `hardenedRuntime: true`, `gatekeeperAssess: false`,
  `entitlements`/`entitlementsInherit` → `build/entitlements.mac.plist`.
- `build/entitlements.mac.plist`: JIT + unsigned-exec memory (Electron/V8), library-validation
  disabled + dyld env vars (to launch the gateway), network client + server.

## Verify a signed build

Download the mac artifact (or open the drafted release), then:
```bash
APP="homun.app"   # inside the .dmg/.zip; folder is lowercase (executableName)
codesign -dv --verbose=4 "$APP"                                   # app: flags include runtime
codesign -dv --verbose=4 "$APP/Contents/Resources/bin/local-first-desktop-gateway"  # gateway signed too
codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose=2 "$APP"                 # Gatekeeper: accepted
xcrun stapler validate "$APP"                                    # notarization ticket stapled
```

## Local signed build (optional fallback)

Needs the Developer ID cert + notarization creds in your environment
(`CSC_LINK`/`CSC_KEY_PASSWORD` + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`):
```bash
cd apps/desktop && npm run dist
```
Unsigned pipeline check (no creds): `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist`.

## Gotchas

- **Hardened runtime + JIT.** Electron needs `allow-jit` + `allow-unsigned-executable-memory`
  (in the plist) or it crashes on launch under the hardened runtime.
- **Launching the gateway** needs `disable-library-validation` + `allow-dyld-environment-variables`
  (in the plist) since the app spawns it with env vars.
- **First notarization is slow** (minutes); electron-builder polls notarytool — don't cancel.
- **Windows/Linux** are manual-download platforms; Windows signing is best-effort and Linux is
  unsigned.
