# Homun License Compliance Design

**Date:** 23 July 2026

**Status:** Approved design, pending implementation plan

**Repositories:** `homun-app/homun-core`, `homun-app/website`

## Goal

Make Homun's source metadata, packaged desktop artifacts, third-party notices, and
public website agree on `FSL-1.1-ALv2`, while preserving all license and copyright
materials required by the software and assets distributed with the desktop app.

The work must close the packaging and public-copy gaps without expanding into a full
container SBOM or automatically publishing a new desktop release.

## Product license source of truth

`homun-core/LICENSE.md` remains the canonical product-license text. The desktop npm
package, every Homun-owned Rust crate, the standalone channel bridges, the README, and
the website must identify the license as `FSL-1.1-ALv2`.

The public explanation must state that each FSL-licensed version becomes
Apache-2.0 on the second anniversary of the date that specific version was first made
available. Homun must be described as source-available before that change date, not as
fully open source.

The website repository will keep one byte-for-byte copy of the canonical English
license in `src/data/homun-core-license.md`. Both localized pages will render that same
file. Its Italian page will translate the explanation but will identify the English
text as the binding license. Tests in both repositories will validate the expected
SHA-256 of the canonical text, so the product and website cannot silently diverge.

## Desktop compliance bundle

Desktop packaging will stage a deterministic compliance bundle under the Electron
resources directory:

```text
Resources/
├── LICENSE.md
├── THIRD_PARTY_NOTICES.md
└── third-party-licenses/
    ├── electron/
    │   ├── LICENSE
    │   └── LICENSES.chromium.html
    ├── rust/
    ├── npm/
    ├── fonts/
    ├── default-skills/
    └── python-runtime/
```

A focused Node module, invoked by `apps/desktop/scripts/prepare-package.mjs`, will:

1. Copy the canonical product license from the repository root.
2. Read locked npm packages and Cargo metadata from already-installed local sources.
3. Copy package-specific `LICENSE`, `COPYING`, `NOTICE`, and copyright files while
   retaining package name, version, declared license, and origin in a readable index.
4. Copy Electron's MIT license and Chromium's generated third-party notice separately.
5. Preserve font licenses and copyright notices, classifying Roboto Slab as
   Apache-2.0 and the remaining curated Fontsource families according to their package
   metadata.
6. Preserve the MIT license for the vendored default-skill snapshot.
7. Document the pinned top-level Python runtime packages and the runtime-downloaded
   speech model without pretending that they are bundled application code.

The module will not make network requests during packaging. It will fail closed if the
canonical FSL file, Electron notices, a declared dependency license, or a required
license text is missing. The only allowed exception is an SPDX-recognized license whose
complete standard text is supplied from the repository's centrally vendored license
templates; any package-specific `NOTICE` remains mandatory. An unknown license can
never be allowlisted.

## Dependency metadata and runtime inputs

The root Cargo workspace will define shared package metadata for version, edition,
authors, repository, homepage, and `FSL-1.1-ALv2`. Homun-owned workspace crates will
inherit it. Standalone channel crates will declare the same license explicitly.

`apps/desktop/package.json` will declare `FSL-1.1-ALv2` directly instead of pointing to
a file absent from `app.asar`. The complete `LICENSE.md` will still be present in the
outer application resources.

Top-level Python packages installed by the contained-computer and graph runtime Docker
builds will be pinned to audited versions in requirements files. Their direct license
and source information will be included in the compliance bundle. Exhaustive package-
manager and base-image SBOM generation is deliberately reserved for a future governance
workstream.

## Website experience

The website will add:

- `/license/`, containing the English explanation, SPDX identifier, complete binding
  terms, repository link, and version change-date table;
- `/it/license/`, containing the Italian explanation, the same binding English terms,
  and the localized change-date table;
- localized license links in the marketing and documentation footers.

A reusable Astro component will read the existing `src/data/releases.json` snapshot.
For every published version it will calculate the change date as two calendar years
after `publishedAt`, then render the version, first-availability date, Apache-2.0 change
date, and GitHub release link. The page therefore follows the same last-known-good
release snapshot already used by the changelog and public roadmap.

The marketing badge `Cloud · open source · local` will become
`Cloud · source-available · local`. References to open-source model providers remain
valid because they describe selectable models rather than Homun's current product
license.

## Error handling

Compliance generation is a release gate, not a best-effort reporting task. Errors must
name the missing component, expected source path, and declared license. Package
preparation must stop before Electron Builder runs when the bundle is incomplete.

Website license checks must fail when either localized page is absent, the binding text
does not match the committed canonical copy, a release has no valid timestamp, a change
date is not exactly two calendar years later, or a footer omits its localized link.

## Test strategy

Implementation follows red-green-refactor:

1. Add failing tests for FSL metadata, successful compliance staging, and each
   fail-closed condition.
2. Implement the smallest staging module that satisfies those tests.
3. Add an integration test that prepares a temporary `Resources` directory from the
   real repository metadata without building the full installer.
4. Add a packaged-artifact check for `LICENSE.md`, `THIRD_PARTY_NOTICES.md`, Electron,
   Chromium, font, and vendored-skill notices.
5. Run the desktop Node tests, typecheck, relevant Cargo metadata/build checks, and the
   packaging preparation gate.
6. Add a failing website build test covering both pages, binding text, calculated dates,
   footer links, canonical URLs, and removal of the inaccurate product-level
   `open source` claim.
7. Build the Astro site, run the dedicated license test and full `npm run check`, then
   inspect both localized pages at desktop and mobile widths.

The GitHub release workflow will run the desktop compliance test before
`electron-builder`. A missing or unknown license therefore blocks a release on macOS,
Windows, and Linux.

## Delivery and publication

Core implementation will happen on an isolated `fabio/license-compliance` branch so it
does not overlap the user's existing working tree. Website implementation will use an
isolated branch in the website repository.

After verification, the website change will be merged and pushed to `main`, then checked
on the live `/license/` and `/it/license/` routes as explicitly requested. The core
change will be left ready for review and integration; it will not trigger or publish a
new desktop release without separate authorization.

## Out of scope

- A complete CycloneDX or SPDX SBOM for Docker base images and operating-system
  packages.
- A policy service or per-release legal registry beyond the website's deterministic
  change-date table.
- Retroactive replacement of already-published installers.
- Automatic publication of a new Homun desktop version.
