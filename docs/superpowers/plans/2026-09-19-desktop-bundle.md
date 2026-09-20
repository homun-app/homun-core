# Standalone desktop packaging continuation

Approved by Fabio's “Continua”, continuing the unfinished desktop item of the recovery plan.

- Build an isolated, hash-locked Python packaging environment and a PyInstaller onedir engine.
- Verify its executable from an unrelated working directory without PYTHONPATH or system Python in PATH, using temporary synthetic data and authenticated health/domain/runtime paths.
- Stage only explicit desktop source, web assets and engine bundle; never copy repository runtime data or secrets.
- Package a local unsigned macOS arm64 Homun.app using pinned Electron and Packager, with a build input receipt. No signing identities, publishing or real-data migration.
- Verify bundled engine from inside the app, archive integrity, package inventory and lifecycle. Attempt native renderer smoke; report separately if the graphical session blocks it.
- Obtain independent spec and quality reviews, run focused checks, update delivery evidence and open release gates.

Acceptance does not claim a clean-Mac certification, notarization, update/rollback support, production Keychain or encryption. Those require separate evidence; source development dependencies must not be required by the shipped executable.

## Outcome

Standalone engine, local .app + ZIP, strict input/artifact verification, frozen durable restart, packaged engine lifecycle, ASAR and archive integrity completed. Six desktop tests, one inventory test and npm check passed. Independent spec and quality findings resolved, including Packager symlink rewriting. Native graphical smoke blocked by locked Mac; no signed release or clean-machine claim. See `docs/research/2026-09-19-desktop-bundle-delivery.md`.
