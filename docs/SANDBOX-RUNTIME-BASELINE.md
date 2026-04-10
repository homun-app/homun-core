# Sandbox Runtime Baseline

Updated: April 6, 2026

## Canonical Core Baseline

The repository now defines a canonical core sandbox runtime image:

- image tag: `homun/runtime-core:2026.03`
- Dockerfile: `docker/sandbox-runtime/Dockerfile`
- build script: `scripts/build_sandbox_runtime_image.sh`

This is the recommended Docker runtime baseline for sandboxed:

- skill scripts
- shell-adjacent helper commands executed through the shared sandbox
- common MCP workloads that only require the core language/runtime toolchain

## macOS 26 Compatibility (April 2026)

The Seatbelt SBPL profiles (`seatbelt_profile.sbpl`, `seatbelt_profile_net_local.sbpl`) were updated for macOS 26 (Darwin 25.x):

- Added `(allow file-read* (literal "/"))` — dyld/libSystem on macOS 26 requires `file-read-data` on the root directory at process startup, not just `file-read-metadata`. Without this, every sandboxed process is killed with SIGABRT before the first instruction.
- Added `(allow file-read* (subpath "/private/var/select"))` — `/var/select` is a symlink to `/private/var/select` but Seatbelt resolves symlinks before matching rules. The old `(subpath "/var/select")` didn't match the real path.
- Shell tool falls back to `sh -c` when sandbox is active — `zsh` has startup issues under Seatbelt on macOS 26+ (exits 1 before processing the command). POSIX `sh` works correctly.

## What The Core Baseline Includes

- Node.js / npm / npx
- `bash`
- `python3`
- `tsx`
- minimal OS utilities needed by common skill and MCP startup flows

## What It Does Not Promise Yet

This core baseline does not claim full browser parity.

Not yet guaranteed in the canonical core image:

- browser binaries and full Playwright browser dependencies
- arbitrary third-party MCP servers fetched on demand from npm inside a no-network sandbox
- every language runtime a custom skill might choose to require

That means:

- built-in browser MCP remains a separate operational concern
- operators may still need a heavier custom image for browser-heavy or ecosystem-heavy MCP setups

## Build

```bash
./scripts/build_sandbox_runtime_image.sh
```

Optional custom tag:

```bash
./scripts/build_sandbox_runtime_image.sh homun/runtime-core:dev
```

From the Permissions UI, the `Build Runtime Baseline` action now calls the same local build flow when the configured image targets a `homun/runtime-core:*` tag.

## Recommended Config Shape

For operators who want to align with the repo baseline:

- `docker_image = "homun/runtime-core:2026.03"`
- `runtime_image_policy = "versioned_tag"`
- `runtime_image_expected_version = "2026.03"`

Applying the current sandbox presets in the UI now uses this baseline by default.

If you build a digest-pinned copy, prefer:

- `runtime_image_policy = "pinned"`
- `runtime_image_expected_version = "<sha256:...>"`

## Why This Exists

Before this baseline, the repo only had an operational default (`node:22-alpine`) and runtime image status/pull logic.

That was enough to run something, but not enough to define what the sandbox should reliably contain for:

- Python skills
- Bash skills
- TypeScript skills
- common Node-based MCP startup paths

This baseline closes that gap for the core runtime contract without pretending browser-complete parity is already solved.
