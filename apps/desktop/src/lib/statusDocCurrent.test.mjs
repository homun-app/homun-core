import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const statusDoc = readFileSync(resolve(here, "../../../../docs/STATO.md"), "utf8");

test("status doc records the merged legacy lifecycle cleanup", () => {
  assert.match(statusDoc, /#375/);
  assert.match(statusDoc, /main` aggiornato a #375 \(`d654a4a0`\)/);
  assert.doesNotMatch(statusDoc, /cleanup legacy UI lifecycle in corso/);
  assert.doesNotMatch(statusDoc, /Chiudere la cleanup legacy UI lifecycle/);
});
