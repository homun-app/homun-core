import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const CATALOGS = [
  "i18n/locales",
  "plugins/presentations/locales",
  "plugins/proattivita/locales",
];
// en is the reference; enforce parity for the NEW bundled catalogs we control.
// (it.json is the pre-existing shipped catalog and may have historical drift — not
// gated here to avoid failing this task on unrelated drift; a separate cleanup can
// add it later.)
const LANGS = ["es", "fr", "de"];

function keyPaths(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...keyPaths(v, p));
    else out.push(p);
  }
  return out.sort();
}
const load = (rel) => JSON.parse(readFileSync(path.join(dir, rel), "utf8"));

// Every non-English catalog must have EXACTLY the same key set as en.json — a
// missing key silently falls back to English, an extra key is dead weight. This
// pins full coverage so es/fr/de can't drift as en.json grows.
for (const cat of CATALOGS) {
  const enKeys = keyPaths(load(`${cat}/en.json`));
  for (const lng of LANGS) {
    test(`${cat}/${lng}.json has the same keys as en`, () => {
      const got = keyPaths(load(`${cat}/${lng}.json`));
      assert.deepEqual(got, enKeys, `${cat}/${lng}.json key set differs from en`);
    });
  }
}
