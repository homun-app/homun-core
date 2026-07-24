import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractReleaseNotes, CHANGELOG_PATH } from "../scripts/extract-release-notes.mjs";

const FIXTURE = `# Changelog

## [Non rilasciato]

## [0.1.2] — 2026-07-24

### Novità
- Alpha
- Beta

### Sicurezza
- Gamma

## [0.1.1] — 2026-06-16
- vecchia voce

[0.1.2]: https://example/tag/v0.1.2
[0.1.1]: https://example/tag/v0.1.1
`;

test("extracts only the requested version's body, without the heading", () => {
  const notes = extractReleaseNotes(FIXTURE, "0.1.2");
  assert.match(notes, /### Novità/);
  assert.match(notes, /- Alpha/);
  assert.match(notes, /### Sicurezza/);
  // Must NOT bleed into the previous OR next section, and must drop its own heading.
  assert.doesNotMatch(notes, /0\.1\.1/);
  assert.doesNotMatch(notes, /vecchia voce/);
  assert.doesNotMatch(notes, /## \[0\.1\.2\]/);
});

test("drops trailing link-reference definitions", () => {
  const notes = extractReleaseNotes(FIXTURE, "0.1.2");
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
