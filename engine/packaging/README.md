# Standalone engine: macOS arm64

Build from the repository root:

```sh
python3 tools/build_engine_bundle.py --python 3.13.12
python3 engine/packaging/smoke.py dist/engine/homun-engine
```

The build uses a fresh temporary virtual environment. `engine/requirements.lock` supplies hash-locked runtime dependencies, while `engine/requirements-packaging.lock` supplies independently hash-locked PyInstaller tooling. The local Homun wheel is built with the locked build backend and installed without resolving dependencies. The developer engine virtual environment is never modified. Pin the build interpreter to the tested CPython 3.13.12 for comparable builds.

The output is an **onedir bundle**: `dist/engine/homun-engine` and its sibling `_internal` directory must travel together. Electron should copy the complete `dist/engine` directory to `resources/engine`. The executable embeds Python and does not launch the developer interpreter. Build inputs are pinned; byte-for-byte reproducibility across machines, SDK versions and code signatures is not claimed.

The profile uses the SQLite memory ledger and explicitly excludes optional Mem0 and Qdrant client modules. It does not introduce SQLCipher; the crypto spike remains separate. Provider adapters included by the runtime lock remain in the bundle. No model server, model weights, credentials, data directory or user files are bundled.

The spec collects Homun/DBOS package data and dynamic imports, Uvicorn modules, Pydantic AI model/provider modules, and their distribution metadata. Installed Logfire/Pydantic integration uses source inspection during import, so Pydantic and Logfire Python source data must also be included. This was identified by the first frozen startup regression.

The smoke test creates a temporary working directory, HOME and data directory, supplies only an ephemeral session token, removes PYTHONPATH and sets PATH to `/nonexistent`. It verifies authenticated health, rejection without credentials, provider registry import, runtime capability, a durable workflow waiting for contribution across a process restart, idempotent completion with exactly one effect receipt, DBOS migrations and graceful termination. It does not call real model providers. All synthetic state is removed and the process is awaited.

To regenerate build tooling pins deliberately:

```sh
uv pip compile engine/requirements-packaging.in --python-version 3.13 --generate-hashes --output-file engine/requirements-packaging.lock --no-config
```

Relevant primary documentation: [PyInstaller spec files](https://pyinstaller.org/en/stable/spec-files.html), [PyInstaller hook utilities](https://pyinstaller.org/en/stable/hooks.html). Output is locally ad-hoc signed by PyInstaller, not Developer ID signed or notarized. Distribution signing and testing on a clean second Mac remain release gates.

## Local verification — 2026-09-19

CPython 3.13.12 / PyInstaller 6.22.3 / hooks-contrib 2026.7 on macOS 26.6.2 arm64. The first frozen launch failed on Logfire source introspection; explicit source data fixed that failure. The resulting bundle passes both authenticated and unauthorized health checks, runtime capability, provider registry reads, migrations through DBOS 114, and a complete synthetic durable workflow across process restart. The contribution replay returns the identical result and only one effect receipt exists. Both runs stop gracefully. Uvicorn re-raises SIGTERM after completing shutdown; the smoke accepts exit 0 or -15 only with the DBOS shutdown log present.

`build-receipt.json` records actual Python version, both dependency-lock hashes, input hashes for the spec/entrypoint/builder/project manifest and every Homun Python source file, plus a source-tree digest. Packaging aborts if source paths or input contents change during the build. The source digest iterates sorted `engine/src/homun/**/*.py` and hashes UTF-8 paths relative to `engine/src` (including `homun/`), a NUL separator, and file bytes. The receipt is emitted only after successful build and input revalidation.

The startup and restart smoke ran with no source checkout as working directory, no PYTHONPATH and no executable search PATH. This demonstrates the bundled runtime in this host environment, not notarization, clean-machine compatibility or external provider authentication.

Artifact binding: `artifact_files` enumerates every generated regular file or symlink except the receipt itself. File entries contain canonical relative `name` and SHA-256; symlink entries contain `name` and `symlink` target. Escaping or dangling symlinks are rejected. Directories are implicit. Verify the exact inventory before and after copying into Electron, rejecting added, missing or modified files. The builder removes any previous receipt before replacing the bundle so a failed build cannot retain a stale acceptance marker.

Inventory regression: `python3 -m unittest discover -s engine/packaging -p 'test_*.py'` exercises regular files, internal symlinks, receipt exclusion and an escaping symlink.
