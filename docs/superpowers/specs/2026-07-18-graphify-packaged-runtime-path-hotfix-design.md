# Graphify packaged runtime path hotfix

## Problem

The packaged desktop gateway launches Graphify while its process working directory is
inside the signed application bundle. Graphify writes a relative
`graphify-out/manifest.json` in that working directory while mapping a project. On
macOS the added file invalidates the app's sealed resources after the first project
analysis, even though the bundle was valid immediately after installation.

## Decision

Keep the gateway process and all existing packaged-resource resolution unchanged.
Only the Graphify subprocess will run with its current directory set to the
gateway-managed persistent mirror already located under the Homun data directory.
Graphify will still receive the mirror path explicitly and will still publish only
the staged `graph.json` through the existing atomic import path.

This is preferred over changing the whole gateway working directory, which could
affect unrelated repo-relative fallbacks, and over Graphify-specific cache environment
variables, which would couple Homun to undocumented tool internals.

## Data and security boundaries

- Runtime cache and manifests remain under `~/.homun/graphify-out/<workspace>/_mirror`.
- The user's project remains read-only; extraction still operates on the managed
  mirror.
- No runtime command may write inside Electron `process.resourcesPath` or the signed
  application bundle.
- The existing staged import, fingerprint, backup, and fail-closed publication rules
  do not change.

## Verification

1. A regression test provides a fake Graphify executable, invokes the real
   `run_graphify` path, and proves the subprocess runs from the managed mirror. The
   test must fail on the release commit before production code changes.
2. Focused gateway tests, the full workspace test suite, and the pre-release gate pass.
3. A new signed/notarized macOS package is installed and verified before launch.
4. After launching and analyzing existing projects twice, `codesign --verify --deep
   --strict`, Gatekeeper assessment, and stapler validation still pass; Memory/Vault
   audit checksums remain stable and both project graphs remain fresh with zero
   duplicate nodes.

## Release handling

Publish a new patch tag rather than modifying `v0.1.1062`. The new release replaces
the locally installed build. The previous app bundle is retained in the existing
backup area until post-launch verification succeeds.
