import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractReleaseNotes, CHANGELOG_PATH } from "../scripts/extract-release-notes.mjs";

// The site parser reads `## Highlights`/`## Improvements`/`## Fixes` (H2) from the release body, so
// section headers are H2 — same level as the `## [version]` delimiters. The extractor must KEEP the
// H2 section headers and stop only at the next `## [version]`.
const FIXTURE = `# Changelog

## [Unreleased]

## [0.1.1079] — 2026-07-24

Intro line shown in the app.

## Highlights
- Alpha highlight
- Beta highlight

## Improvements
- Gamma improvement

## [0.1.1078] — 2026-06-16

## Fixes
- old fix

[0.1.1079]: https://example/tag/v0.1.1079
[0.1.1078]: https://example/tag/v0.1.1078
`;

test("extracts one version's body — keeps its ## H2 sections, stops at the next ## [version]", () => {
  const notes = extractReleaseNotes(FIXTURE, "0.1.1079");
  assert.match(notes, /## Highlights/); // an H2 section header is content, NOT a delimiter
  assert.match(notes, /- Alpha highlight/);
  assert.match(notes, /## Improvements/);
  assert.match(notes, /Intro line shown in the app/); // the intro before the first section is kept
  // Must stop at the next version and drop its own version heading + link refs.
  assert.doesNotMatch(notes, /0\.1\.1078/);
  assert.doesNotMatch(notes, /old fix/);
  assert.doesNotMatch(notes, /## \[0\.1\.1079\]/);
});

test("drops trailing link-reference definitions", () => {
  const notes = extractReleaseNotes(FIXTURE, "0.1.1079");
  assert.doesNotMatch(notes, /example\/tag/);
});

test("returns null for a version with no section (caller must error, never ship empty notes)", () => {
  assert.equal(extractReleaseNotes(FIXTURE, "9.9.9"), null);
});

test("the real CHANGELOG.md has a non-empty section for the shipping version", () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const notes = extractReleaseNotes(readFileSync(CHANGELOG_PATH, "utf8"), version);
  assert.ok(notes && notes.length > 40, `${version} section should exist and be substantial`);
  assert.doesNotMatch(notes, /## \[/, "must not include another version heading");
});
