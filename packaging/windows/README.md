# Windows packaging — intentionally empty

Homun v1.0 does not ship a native Windows installer. Windows users install
via WSL2 using the Linux `.deb` package — see
[`docs/INSTALL-WINDOWS-WSL.md`](../../docs/INSTALL-WINDOWS-WSL.md) for the
full guide.

## Why this directory exists

To make the design decision explicit and to reserve the place for a future
native installer (cargo-wix + Authenticode) when the project budget supports
Windows code signing. Tracked as issue #67 in `docs/REALITY-AUDIT.md`.

## What a future native installer would contain

When Windows code signing is configured:

- `main.wxs` — WiX Toolkit schema defining the install layout
- `sign-msi.ps1` — PowerShell signing script using `signtool`
- `cargo-wix.toml` — cargo-wix configuration (or `[package.metadata.wix]` in `Cargo.toml`)
- Maintainer scripts for Windows Service installation (the Windows equivalent
  of `packaging/linux/debian/postinst` creating a dedicated local service account)

The `.github/workflows/release.yml` workflow is structured to add a
`package-windows` job without rewrites — it only needs the packaging
scaffolding to land in this directory.

See also `docs/INSTALLER-SIGNING-SETUP.md` for the Authenticode acquisition
path when we decide to pull the trigger.
