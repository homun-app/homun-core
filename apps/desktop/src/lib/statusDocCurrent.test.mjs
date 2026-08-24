import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const statusDoc = readFileSync(resolve(here, "../../../../docs/STATO.md"), "utf8");

test("status doc records the merged legacy lifecycle cleanup", () => {
  assert.match(statusDoc, /#375/);
  assert.doesNotMatch(statusDoc, /cleanup legacy UI lifecycle in corso/);
  assert.doesNotMatch(statusDoc, /Chiudere la cleanup legacy UI lifecycle/);
});

test("status doc records a concrete current main baseline without stale slice branch", () => {
  assert.match(
    statusDoc,
    /\| HEAD codice verificato \| `main` aggiornato a #[0-9]+ \(`[0-9a-f]{8}`\) \|/,
  );
  assert.doesNotMatch(statusDoc, /fabio\/status-after-ui-lifecycle-retirement/);
});

test("status doc records the merged runtime view model turn contract", () => {
  assert.match(statusDoc, /#377/);
  assert.match(statusDoc, /#379/);
  assert.match(statusDoc, /#380/);
  assert.match(statusDoc, /main` aggiornato a #380 \(`e62e8b6a`\)/);
  assert.doesNotMatch(statusDoc, /slice runtimeViewModel turn status in corso/);
  assert.doesNotMatch(statusDoc, /fabio\/ui-runtime-view-model-turn-contract/);
});

test("status doc records the merged composer-mode presenter cleanup slice", () => {
  assert.match(statusDoc, /Slice UI composer-mode presenter contract mergeata #379/);
  assert.match(statusDoc, /fabio\/docs-composer-mode-owner-cleanup/);
  assert.match(statusDoc, /doc composer-mode owner cleanup in corso/);
  assert.doesNotMatch(statusDoc, /Slice locale UI composer-mode presenter contract in corso/);
  assert.doesNotMatch(statusDoc, /fabio\/ui-composer-mode-presenter-contract/);
  assert.doesNotMatch(statusDoc, /fabio\/status-after-composer-mode-presenter/);
  assert.match(statusDoc, /routeComposerSubmission` non deve piu' derivare localmente il composer mode/);
});
