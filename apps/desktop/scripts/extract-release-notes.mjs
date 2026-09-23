#!/usr/bin/env node
// Single source of truth = repo-root CHANGELOG.md. This extracts ONE version's section (the body
// under its `## [x.y.z] — ...` heading, without the heading itself) so the release pipeline can put
// it into the GitHub Release body — from which BOTH the app's in-app "what's new" (electron-updater
// github provider reads releaseNotes from the release body) AND the website /changelog (GitHub
// Releases API) render. Keep a Changelog format.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// apps/desktop/scripts -> app repo root (where CHANGELOG.md lives).
export const CHANGELOG_PATH = path.resolve(HERE, "..", "..", "..", "CHANGELOG.md");

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the notes body for `version` (everything between its `## [version]` heading and the next
 * `## [` heading or EOF), trimmed and with trailing link-reference definitions dropped. `null` when
 * the version has no section — the caller MUST treat that as a hard error (never ship an empty
 * changelog for a real release).
 */
export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\]`);
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    // Drop link-reference definitions like `[0.1.2]: https://…` that live at the file's end.
    .filter((l) => !/^\[[^\]]+\]:\s*\S+/.test(l))
    .join("\n")
    .trim();
  return body || null;
}

// CLI: `node extract-release-notes.mjs <version>` prints the section to stdout (exit 1 if missing).
if (import.meta.url === `file://${process.argv[1]}`) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: extract-release-notes.mjs <version>");
    process.exit(2);
  }
  const notes = extractReleaseNotes(readFileSync(CHANGELOG_PATH, "utf8"), version);
  if (!notes) {
    console.error(`No CHANGELOG.md section for version ${version} (at ${CHANGELOG_PATH}).`);
    process.exit(1);
  }
  process.stdout.write(notes + "\n");
}
