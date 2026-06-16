# Release — macOS (signing + notarization)

Releases are built **in CI** by GitHub Actions, not locally. This doc explains the
pipeline, the secrets, and how to verify a build passes Gatekeeper.

## How releases are built

`.github/workflows/build.yml` ("Build installers"):
- **Push a `v*` tag** → builds mac (arm64) + win + linux installers and **publishes** each
  one — together with the `latest*.yml` auto-update metadata — to a **draft release in the
  public `homun-releases` repo** (`electron-builder --publish always`, `GH_TOKEN=RELEASES_TOKEN`).
  Review that draft and publish it; that release is also the auto-update feed (see below).
- **Run manually** (Actions tab → *Build installers* → *Run workflow*, i.e. `workflow_dispatch`)
  → builds + uploads artifacts only (`--publish never`). Use this to verify the pipeline before tagging.

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

The mac job builds **signed + notarized** (`electron-builder --mac -c.mac.notarize=true`) when
`MAC_CSC_LINK` is non-empty, else it falls back to an **unsigned** build. The presence check
runs in a shell step (`steps.signing.outputs.has_cert`) that logs the cert state explicitly.

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

1. **Create a public repo `homun-app/homun-releases`** (empty is fine). This is the update
   feed `apps/desktop/package.json` → `build.publish` points at, and what electron-updater
   queries at runtime (no token embedded in the app).
   ```bash
   gh repo create homun-app/homun-releases --public -d "Homun desktop release binaries"
   ```
2. **Add a `RELEASES_TOKEN` secret** on `homun-core` — a PAT that can write releases to
   `homun-releases` (the default `GITHUB_TOKEN` can't reach another repo). Fine-grained PAT
   scoped to `homun-releases` with **Contents: read/write**, or a classic PAT with `repo`.
   ```bash
   gh secret set RELEASES_TOKEN --repo homun-app/homun-core   # paste the PAT
   ```

After that, every `v*` tag publishes the installers **and** `latest-mac.yml` / `latest.yml` /
`latest-linux.yml` to a draft release in `homun-releases`. **Publish that draft** for clients to
see the update (a draft is invisible to electron-updater). The `.yml` files are what make the
update discoverable — a hand-made release with only `.dmg`/`.exe` would never trigger an update.

> Updates only flow **between published releases newer than the running build**. You can't test
> the in-app card until at least one release is published in `homun-releases` and a client is
> running an older version. In dev (`app.isPackaged === false`) the check is a deliberate no-op.

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
- **Windows/Linux** are built but unsigned (Windows distribution needs its own code-signing cert).
