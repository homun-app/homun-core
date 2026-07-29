# Homun License Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Homun's source metadata, desktop artifacts, third-party notices, and public website consistently disclose `FSL-1.1-ALv2` and all shipped license materials.

**Architecture:** `homun-core/LICENSE.md` remains canonical. A testable Node staging module builds an offline compliance bundle from locked Cargo/npm metadata, SPDX texts, Electron/Chromium notices, font notices, vendored-skill attribution, and pinned Python runtime declarations. The Astro website renders one exact license copy in English and Italian and calculates each release's Apache-2.0 change date from the existing release snapshot.

**Tech Stack:** Node.js test runner, Electron Builder, Cargo metadata, Python `unittest`, Astro/Starlight/MDX, GitHub Actions.

---

## File structure

Core responsibilities:

- `apps/desktop/tests/license-metadata.test.mjs`: product-license declarations across npm, Cargo, and README.
- `apps/desktop/tests/license-runtime-inputs.test.mjs`: pinned Python inputs and vendored-skill attribution.
- `apps/desktop/tests/license-compliance.test.mjs`: unit and real-repository staging contracts.
- `apps/desktop/scripts/license-compliance.mjs`: dependency discovery, policy validation, notice generation, and resource staging.
- `apps/desktop/scripts/verify-license-compliance.mjs`: validates prepared and final Electron resource directories.
- `apps/desktop/scripts/prepare-package.mjs`: invokes compliance staging before Electron Builder.
- `apps/desktop/scripts/after-pack-fuses.mjs`: validates the final platform-specific resource path after packaging.
- `scripts/build_fonts.py`: copies font files and their package license/copyright material.
- `scripts/tests/test_build_fonts.py`: font notice regression tests.
- `compliance/python-runtime.json`: audited direct Python/model declarations.
- `resources/default-skills/LICENSE.md`: MIT attribution for the vendored skill snapshot.
- `runtimes/contained-computer/requirements-whisper.txt`: pinned speech package.
- `runtimes/contained-computer/requirements-deck.txt`: pinned presentation package.
- `runtimes/graphify/requirements.txt`: pinned graph package.

Website responsibilities:

- `src/data/homun-core-license.md`: byte-for-byte canonical FSL copy.
- `src/components/docs/LicenseText.astro`: renders the shared binding text once.
- `src/components/docs/LicenseReleaseTable.astro`: calculates and renders per-version change dates.
- `src/content/docs/license.mdx`: English legal page.
- `src/content/docs/it/license.mdx`: Italian legal page.
- `scripts/check-license-build.mjs`: validates both built routes, dates, text, and footer links.

## Task 1: Align Homun-owned package metadata

**Files:**

- Create: `apps/desktop/tests/license-metadata.test.mjs`
- Modify: `Cargo.toml`
- Modify: `crates/browser-automation/Cargo.toml`
- Modify: `crates/capabilities/Cargo.toml`
- Modify: `crates/context-compression/Cargo.toml`
- Modify: `crates/desktop-gateway/Cargo.toml`
- Modify: `crates/engine/Cargo.toml`
- Modify: `crates/host-computer/Cargo.toml`
- Modify: `crates/inference-usage/Cargo.toml`
- Modify: `crates/inference/Cargo.toml`
- Modify: `crates/local-computer-session/Cargo.toml`
- Modify: `crates/memory/Cargo.toml`
- Modify: `crates/orchestrator/Cargo.toml`
- Modify: `crates/process-manager/Cargo.toml`
- Modify: `crates/process-skill/Cargo.toml`
- Modify: `crates/secrets/Cargo.toml`
- Modify: `crates/skill-runtime/Cargo.toml`
- Modify: `crates/subagents/Cargo.toml`
- Modify: `crates/task-runtime/Cargo.toml`
- Modify: `crates/vault/Cargo.toml`
- Modify: `runtimes/channel-telegram/Cargo.toml`
- Modify: `runtimes/channel-whatsapp/Cargo.toml`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/package-lock.json`
- Modify: `README.md`

- [ ] **Step 1: Write the failing metadata test**

Create a Node test that reads every manifest and requires `FSL-1.1-ALv2`, checks the
desktop package uses the SPDX identifier instead of `SEE LICENSE IN`, checks the
canonical license SHA-256
`5904c160d2d93c62e0113b5cc9d20a6880e04839bff3a130bd622cc141a64429`, and requires
the README wording “each version becomes Apache-2.0 two years after that version is
made available.”

```js
test("Homun-owned packages use the canonical FSL identifier", async () => {
  assert.equal(desktop.license, "FSL-1.1-ALv2");
  assert.equal(sha256(await read("LICENSE.md")), EXPECTED_LICENSE_SHA256);
  for (const manifest of workspaceManifests) {
    assert.match(await read(manifest), /license\.workspace = true/);
  }
  for (const manifest of channelManifests) {
    assert.match(await read(manifest), /license = "FSL-1\.1-ALv2"/);
  }
  assert.match(await read("README.md"), /each version becomes Apache-2\.0 two years after that version is made available/i);
});
```

- [ ] **Step 2: Run the metadata test and verify RED**

Run: `cd apps/desktop && node --test tests/license-metadata.test.mjs`

Expected: FAIL because the desktop package points to `LICENSE.md`, Cargo packages have
no license metadata, and README wording is vague.

- [ ] **Step 3: Add shared workspace metadata and inherit it**

Add to the root manifest:

```toml
[workspace.package]
version = "0.1.0"
edition = "2024"
authors = ["Fabio Cantone"]
license = "FSL-1.1-ALv2"
repository = "https://github.com/homun-app/homun-core"
homepage = "https://homun.app"
```

In each of the 18 workspace crate manifests, retain `name` and replace the duplicated
version/edition fields with:

```toml
version.workspace = true
edition.workspace = true
authors.workspace = true
license.workspace = true
repository.workspace = true
homepage.workspace = true
```

Add explicit `authors`, `license`, `repository`, and `homepage` fields to both standalone
channel manifests because they cannot inherit from the root workspace.

- [ ] **Step 4: Align npm and README metadata**

Set `license` to `FSL-1.1-ALv2` in both the desktop `package.json` and lockfile root
package. Replace the README license paragraph with:

```md
Each FSL-licensed version becomes Apache-2.0 two years after that version is made
available. See [LICENSE.md](LICENSE.md) for the complete terms.
```

- [ ] **Step 5: Verify GREEN and Cargo metadata**

Run:

```bash
cd apps/desktop && node --test tests/license-metadata.test.mjs
cd ../.. && cargo metadata --locked --format-version 1 --no-deps >/dev/null
```

Expected: test PASS and Cargo metadata exits 0.

- [ ] **Step 6: Commit metadata alignment**

```bash
git add Cargo.toml crates/*/Cargo.toml runtimes/channel-telegram/Cargo.toml runtimes/channel-whatsapp/Cargo.toml apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/tests/license-metadata.test.mjs README.md
git commit -m "chore: align Homun license metadata"
```

## Task 2: Pin runtime packages and preserve vendored-skill attribution

**Files:**

- Create: `apps/desktop/tests/license-runtime-inputs.test.mjs`
- Create: `runtimes/contained-computer/requirements-whisper.txt`
- Create: `runtimes/contained-computer/requirements-deck.txt`
- Create: `runtimes/graphify/requirements.txt`
- Create: `compliance/python-runtime.json`
- Create: `resources/default-skills/LICENSE.md`
- Modify: `runtimes/contained-computer/Dockerfile`
- Modify: `runtimes/graphify/Dockerfile`
- Modify: `scripts/vendor-default-skills.sh`

- [ ] **Step 1: Write the failing runtime-input test**

Require exact pins, Docker installs via requirements files, MIT/default-skill notice,
and the model source/license declaration.

```js
assert.equal(await read("runtimes/contained-computer/requirements-whisper.txt"), "faster-whisper==1.2.1\n");
assert.equal(await read("runtimes/contained-computer/requirements-deck.txt"), "python-pptx==1.0.2\n");
assert.equal(await read("runtimes/graphify/requirements.txt"), "graphifyy==0.9.25\n");
assert.match(await read("resources/default-skills/LICENSE.md"), /MIT License/);
assert.deepEqual(runtime.model, {
  name: "faster-whisper-large-v3-turbo",
  source: "https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo",
  license: "MIT",
  distribution: "downloaded-at-runtime"
});
```

- [ ] **Step 2: Run and verify RED**

Run: `cd apps/desktop && node --test tests/license-runtime-inputs.test.mjs`

Expected: FAIL because requirements, runtime inventory, and skill notice are absent.

- [ ] **Step 3: Add pinned requirements and runtime inventory**

Use the exact requirement lines shown above. Add `compliance/python-runtime.json` with
the three direct PyPI packages, their MIT declarations/source URLs, and the model object
from the test. Do not claim the model is bundled.

- [ ] **Step 4: Route Docker builds through the pins**

For the contained computer, copy each requirements file before its venv install and use:

```dockerfile
COPY requirements-whisper.txt /tmp/requirements-whisper.txt
RUN python3 -m venv /opt/whisper-venv \
    && /opt/whisper-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/whisper-venv/bin/pip install --no-cache-dir -r /tmp/requirements-whisper.txt

COPY requirements-deck.txt /tmp/requirements-deck.txt
RUN python3 -m venv /opt/deck-venv \
    && /opt/deck-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/deck-venv/bin/pip install --no-cache-dir -r /tmp/requirements-deck.txt
```

For Graphify, copy `requirements.txt` and run
`pip install --no-cache-dir -r /tmp/requirements.txt`.

- [ ] **Step 5: Preserve the vendored-skill MIT license**

Add the upstream MIT text with `Copyright (c) 2026 Fabio` to
`resources/default-skills/LICENSE.md`. Change the vendor script so it saves that file
before replacing the directory and restores it immediately after `mkdir -p "$DEST"`;
if the notice is absent, fail before deleting the destination.

- [ ] **Step 6: Verify GREEN**

Run: `cd apps/desktop && node --test tests/license-runtime-inputs.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit runtime inputs**

```bash
git add compliance/python-runtime.json resources/default-skills/LICENSE.md runtimes/contained-computer/requirements-*.txt runtimes/contained-computer/Dockerfile runtimes/graphify/requirements.txt runtimes/graphify/Dockerfile scripts/vendor-default-skills.sh apps/desktop/tests/license-runtime-inputs.test.mjs
git commit -m "chore: pin licensed runtime inputs"
```

## Task 3: Generate font attribution beside bundled fonts

**Files:**

- Create: `scripts/tests/test_build_fonts.py`
- Modify: `scripts/build_fonts.py`
- Generate: `runtimes/contained-computer/fonts/licenses/**`
- Generate: `runtimes/contained-computer/fonts/THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: Write a failing Python fixture test**

Create temporary Fontsource-style packages for one OFL font and Roboto Slab
Apache-2.0, run an extracted `bundle_fonts()` function, and assert that WOFF2 files,
license files, metadata, and the aggregate notice are generated. Also assert the module
docstring no longer describes the complete collection as OFL-only.

```python
self.assertEqual((licenses / "roboto-slab" / "LICENSE").read_text(), APACHE_TEXT)
notice = (fonts / "THIRD_PARTY_NOTICES.md").read_text()
self.assertIn("Roboto Slab | Apache-2.0", notice)
self.assertIn("Inter | OFL-1.1", notice)
```

- [ ] **Step 2: Run and verify RED**

Run: `python3 -m unittest scripts.tests.test_build_fonts -v`

Expected: FAIL because `bundle_fonts()` and notice generation do not exist.

- [ ] **Step 3: Refactor the generator without changing font output**

Move the current body into
`bundle_fonts(node_root, fonts_dir, py_manifest, ts_manifest, curated=CURATED)`. For
each unique Fontsource package, read `package.json`, require a non-empty license, copy
all `LICENSE*`, `COPYING*`, `NOTICE*`, and `COPYRIGHT*` files into
`fonts/licenses/<package>/`, and write a deterministic Markdown table sorted by family.
Fail with the package path and license when required files are missing.

- [ ] **Step 4: Verify fixture GREEN and regenerate real outputs**

```bash
python3 -m unittest scripts.tests.test_build_fonts -v
python3 scripts/build_fonts.py
git diff --check
```

Expected: tests PASS; the real notice identifies Roboto Slab as Apache-2.0 and the
other curated families from their actual package metadata.

- [ ] **Step 5: Commit font attribution**

```bash
git add scripts/build_fonts.py scripts/tests/test_build_fonts.py runtimes/contained-computer/fonts apps/desktop/src/components/fontsManifest.ts runtimes/contained-computer/fonts_manifest.py
git commit -m "chore: bundle font license notices"
```

## Task 4: Build the offline desktop compliance bundle

**Files:**

- Create: `apps/desktop/scripts/license-compliance.mjs`
- Create: `apps/desktop/tests/license-compliance.test.mjs`
- Create: `compliance/licenses/LLVM-exception.txt`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/package-lock.json`
- Modify: `apps/desktop/scripts/prepare-package.mjs`

- [ ] **Step 1: Add locked SPDX tooling**

Run:

```bash
cd apps/desktop
npm install --save-dev --save-exact spdx-expression-parse@5.0.0 spdx-license-list@6.11.0
```

These packages are build-time inputs only and make standard license texts available
offline after `npm ci`.

Add the SPDX LLVM exception text as `compliance/licenses/LLVM-exception.txt`; this is
the only `WITH` exception present in the audited Cargo graph and must be emitted beside
the Apache-2.0 text whenever an expression references it.

- [ ] **Step 2: Write failing unit tests for staging and policy**

Use temporary fixture roots. Cover: canonical FSL copy; SPDX hash validation; npm and
Cargo inventory deduplication; package-specific notice copying; SPDX-text fallback;
Electron/Chromium copying; font/default-skill/Python inclusion; deterministic ordering;
failure for an unknown expression; failure for missing required Electron notices.

```js
await stageLicenseCompliance(fixtureOptions);
assert.equal(await readFile(join(out, "LICENSE.md"), "utf8"), canonicalLicense);
assert.match(await readFile(join(out, "THIRD_PARTY_NOTICES.md"), "utf8"), /demo-crate \| 1\.2\.3 \| MIT/);
await assert.rejects(
  () => stageLicenseCompliance({ ...fixtureOptions, npmPackages: [{ license: "UNKNOWN" }] }),
  /Unknown license.*demo-package/
);
```

- [ ] **Step 3: Run and verify RED**

Run: `cd apps/desktop && node --test tests/license-compliance.test.mjs`

Expected: FAIL because the staging module is absent.

- [ ] **Step 4: Implement dependency discovery and SPDX validation**

Export focused functions:

```js
export function packagesFromNpmLock(lock, packageRoot) {
  return Object.entries(lock.packages ?? {})
    .filter(([key, value]) => key && value.dev !== true)
    .map(([key, value]) => {
      const sourceDir = path.join(packageRoot, key);
      const installed = JSON.parse(readFileSync(path.join(sourceDir, "package.json"), "utf8"));
      return {
        ecosystem: "npm",
        name: value.name ?? installed.name ?? key.replace(/^node_modules\//, ""),
        version: value.version ?? installed.version,
        license: value.license ?? installed.license,
        repository: installed.repository,
        sourceDir,
      };
    })
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

export function packagesFromCargoMetadata(metadata) {
  const workspace = new Set(metadata.workspace_members);
  return metadata.packages
    .filter((pkg) => !workspace.has(pkg.id))
    .map((pkg) => ({
      ecosystem: "cargo",
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      authors: pkg.authors,
      repository: pkg.repository,
      sourceDir: path.dirname(pkg.manifest_path),
    }))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

export function licenseIds(expression) {
  const ids = new Set();
  const exceptions = new Set();
  const visit = (node) => {
    if (node.license) {
      ids.add(node.license);
      if (node.exception) exceptions.add(node.exception);
      return;
    }
    visit(node.left);
    visit(node.right);
  };
  visit(parseSpdx(expression.replaceAll("/", " OR ")));
  return { ids: [...ids].sort(), exceptions: [...exceptions].sort() };
}
```

Run `cargo metadata --locked --format-version 1` for the root workspace and both channel
manifest paths. Scan the desktop and browser-automation lockfiles. Deduplicate by
ecosystem/name/version. For every package, copy package-specific legal files when
present; always list authors/repository/license expression. For recognized SPDX IDs,
store the standard text once under `third-party-licenses/spdx/`. Retain exception texts
and all package-specific `NOTICE` files even when a standard text exists.

- [ ] **Step 5: Add explicit packaged components**

Copy:

- root `LICENSE.md` to `Resources/LICENSE.md`;
- Electron `LICENSE` and `dist/LICENSES.chromium.html`;
- `runtimes/contained-computer/fonts/licenses` and font notice;
- `resources/default-skills/LICENSE.md`;
- `compliance/python-runtime.json` plus a rendered Python/model notice.

Write `THIRD_PARTY_NOTICES.md` with sections for Electron/Chromium, Rust, npm, fonts,
default skills, and runtime-downloaded components.

- [ ] **Step 6: Integrate with package preparation**

Import and await `stageLicenseCompliance()` at the end of resource staging, before the
success logs. Add:

```json
"test:license-compliance": "node --test tests/license-metadata.test.mjs tests/license-runtime-inputs.test.mjs tests/license-compliance.test.mjs"
```

- [ ] **Step 7: Verify GREEN with fixtures and real repository metadata**

```bash
cd apps/desktop
npm run test:license-compliance
node scripts/license-compliance.mjs --output .package/license-smoke
```

Expected: all tests PASS and the smoke directory contains the product license, aggregate
notice, Electron/Chromium notices, and all six third-party sections.

- [ ] **Step 8: Commit the compliance generator**

```bash
git add apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/scripts/license-compliance.mjs apps/desktop/scripts/prepare-package.mjs apps/desktop/tests/license-compliance.test.mjs compliance/licenses/LLVM-exception.txt
git commit -m "feat: stage desktop license compliance bundle"
```

## Task 5: Block incomplete packaged artifacts in CI

**Files:**

- Create: `apps/desktop/scripts/verify-license-compliance.mjs`
- Create: `apps/desktop/tests/license-package-verifier.test.mjs`
- Modify: `apps/desktop/scripts/after-pack-fuses.mjs`
- Modify: `apps/desktop/package.json`
- Modify: `.github/workflows/build.yml`

- [ ] **Step 1: Write failing verifier tests**

Build a complete temporary resource tree and trees missing one required item at a time.
Require actionable errors naming the absent path.

```js
assert.doesNotThrow(() => verifyLicenseResources(completeResources));
assert.throws(
  () => verifyLicenseResources(missingChromiumResources),
  /third-party-licenses\/electron\/LICENSES\.chromium\.html/
);
```

- [ ] **Step 2: Run and verify RED**

Run: `cd apps/desktop && node --test tests/license-package-verifier.test.mjs`

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement prepared/final resource verification**

Export `verifyLicenseResources(resourcesDir)`. Require non-empty product license,
aggregate notice, Electron/Chromium notices, and non-empty Rust/npm/font/default-skill/
Python sections. The CLI accepts `--resources resources-directory` and exits non-zero
on failure.

- [ ] **Step 4: Invoke the verifier from `afterPack`**

Resolve the final resources directory per platform:

```js
function packagedResourcesPath(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}
```

Call `verifyLicenseResources()` before fuse mutation so a bad package stops immediately.

- [ ] **Step 5: Add the release gate**

Run `npm run test:license-compliance` and the verifier after `npm run package:prepare`
in `.github/workflows/build.yml`, before Electron Builder executes.

- [ ] **Step 6: Verify GREEN**

```bash
cd apps/desktop
node --test tests/license-package-verifier.test.mjs
npm run test:license-compliance
npm run test:electron
```

Expected: all Node tests PASS.

- [ ] **Step 7: Commit the gate**

```bash
git add apps/desktop/scripts/verify-license-compliance.mjs apps/desktop/tests/license-package-verifier.test.mjs apps/desktop/scripts/after-pack-fuses.mjs apps/desktop/package.json .github/workflows/build.yml
git commit -m "ci: block incomplete license bundles"
```

## Task 6: Add bilingual license pages to the website

**Repository:** `/Users/fabio/Projects/Homun/website`

**Files:**

- Create: `src/data/homun-core-license.md`
- Create: `src/components/docs/LicenseText.astro`
- Create: `src/components/docs/LicenseReleaseTable.astro`
- Create: `src/lib/license-dates.mjs`
- Create: `src/content/docs/license.mdx`
- Create: `src/content/docs/it/license.mdx`
- Create: `scripts/check-license-build.mjs`
- Modify: `src/components/Footer.astro`
- Modify: `src/components/docs/Footer.astro`
- Modify: `package.json`

- [ ] **Step 1: Create an isolated website worktree**

Verify the repository's worktree convention and ignored directory, then create branch
`fabio/license-page` from current `main`. Run `npm ci` and the existing baseline
`npm run check` before edits.

- [ ] **Step 2: Write the failing built-site contract**

Add `test:license` to `package.json`. The script reads `dist/license/index.html` and
`dist/it/license/index.html`, validates localized explanations, SPDX identifier,
canonical URLs, complete binding text markers, latest release, calculated date, all
release links, and localized footer links. It must also scan marketing output and reject
`Cloud · open source · local`.

```js
assert.match(english, /<link rel="canonical" href="https:\/\/homun\.app\/license\/"/);
for (const marker of ["FSL-1.1-ALv2", "Future License", "Apache License 2.0"]) {
  assert.ok(visibleText(english).includes(marker), `English license page is missing ${marker}`);
}
assert.equal(changeDate("2026-07-22T12:23:28Z"), "2028-07-22T12:23:28.000Z");
assert.ok(homepage.includes("Cloud · source-available · local"));
```

- [ ] **Step 3: Run and verify RED**

Run: `npm run build && npm run test:license`

Expected: FAIL because the routes and links do not exist and the homepage still says
`open source`.

- [ ] **Step 4: Add the single binding license source**

Copy `homun-core/LICENSE.md` byte-for-byte to
`src/data/homun-core-license.md`. `LicenseText.astro` imports it with `?raw`, validates
the known SHA-256 at build time, and renders it in a wrapped, readable `<pre>` with an
accessible heading. Both MDX pages use this same component.

- [ ] **Step 5: Add deterministic release dates**

`LicenseReleaseTable.astro` imports `releases` from `src/lib/product-data.ts` and
`changeDate` from `src/lib/license-dates.mjs`. Implement the helper as:

```ts
export function changeDate(publishedAt) {
  const date = new Date(publishedAt);
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid release timestamp: ${publishedAt}`);
  date.setUTCFullYear(date.getUTCFullYear() + 2);
  return date.toISOString();
}
```

Render version, localized availability date, localized change date, and GitHub link for
every snapshot release. The English explanation states that each version converts on
its own displayed date; the Italian page states the same and identifies the English
terms as binding.

- [ ] **Step 6: Add localized navigation and correct public wording**

Add `License`/`Licenza` links to both footers. In the marketing footer replace the
product badge with `Cloud · source-available · local`. Add `npm run test:license` to the
existing `check` chain so the legal pages cannot bypass the normal site gate.

- [ ] **Step 7: Verify GREEN**

```bash
npm run build
npm run test:license
npm run check
```

Expected: build and all website checks PASS.

- [ ] **Step 8: Commit website implementation**

```bash
git add src/data/homun-core-license.md src/components/docs/LicenseText.astro src/components/docs/LicenseReleaseTable.astro src/lib/license-dates.mjs src/content/docs/license.mdx src/content/docs/it/license.mdx src/components/Footer.astro src/components/docs/Footer.astro scripts/check-license-build.mjs package.json
git commit -m "feat: publish Homun license pages"
```

## Task 7: Render, publish, and verify the website

**Files:** Website build output only; no source file changes expected after a clean render.

- [ ] **Step 1: Start the built-site preview**

Run `npm run preview -- --host 127.0.0.1 --port 4321` from the website worktree.

- [ ] **Step 2: Inspect four target views**

Use the browser-control skill to inspect:

- `/license/` at 1440×900;
- `/license/` at 390×844;
- `/it/license/` at 1440×900;
- `/it/license/` at 390×844.

Verify headings, wrapped legal text, table overflow behavior, footer links, localized
labels, and absence of horizontal page overflow. Capture screenshots as evidence.

- [ ] **Step 3: Re-run the full website gate after any visual correction**

Run: `npm run check`

Expected: PASS with zero failed checks.

- [ ] **Step 4: Integrate and publish the website**

Fast-forward or merge `fabio/license-page` into the clean website `main`, push `main`,
and wait for the existing Coolify deployment to report the new revision healthy. Do not
force-push.

- [ ] **Step 5: Verify live routes**

Open `https://homun.app/license/` and `https://homun.app/it/license/`; repeat desktop and
mobile checks and confirm the canonical URLs and current latest release/date are live.

## Task 8: Full core verification and handoff

**Files:** All core files changed in Tasks 1–5.

- [ ] **Step 1: Run focused compliance gates**

```bash
cd apps/desktop
npm run test:license-compliance
node --test tests/license-package-verifier.test.mjs
python3 ../../scripts/build_fonts.py
cd ../..
python3 -m unittest scripts.tests.test_build_fonts -v
```

- [ ] **Step 2: Run desktop and Rust verification**

```bash
cd apps/desktop
npm run typecheck
npm run test:electron
cd ../..
cargo metadata --locked --format-version 1 --no-deps >/dev/null
cargo build --workspace
```

Expected: all commands exit 0. Existing compiler warnings must be reported as warnings,
not represented as a clean-warning build.

- [ ] **Step 3: Build and inspect an unsigned macOS application directory**

Run:

```bash
cd apps/desktop
npm run package:prepare
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --dir --mac --arm64
node scripts/verify-license-compliance.mjs --resources dist-installers/mac-arm64/Homun.app/Contents/Resources
```

Expected: Electron Builder invokes `afterPack`, the verifier exits 0 both inside the
hook and from the explicit command, and the `.app` contains the complete compliance
bundle. This verifies the macOS application directory, not DMG/ZIP signing or the
Windows/Linux installers; those platforms remain covered by the same fail-closed CI
hook on their native runners.

- [ ] **Step 4: Review the complete diff**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate --max-count=8
```

Confirm only license-compliance scope is present and the user's original working tree
has not changed.

If verification exposes a defect, return to the task that owns that file, add a failing
regression test, repeat its RED/GREEN commands, and amend that task with a separate
`test: close license compliance gaps` commit. Do not merge, push, or publish a desktop
release without separate authorization.
