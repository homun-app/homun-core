import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const workflowPath = path.resolve(import.meta.dirname, "../../../.github/workflows/build.yml");

test("installer matrix depends on same-run release readiness", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /^  validate:\n    name: Release readiness$/m);
  assert.match(workflow, /python3 scripts\/pre_release_gate\.py/);
  assert.doesNotMatch(
    workflow,
    /- name: Install desktop dependencies\n        working-directory: apps\/desktop\n        run: npm ci/,
  );
  assert.match(
    workflow,
    /rustsec\/audit-check@69366f33c96575abad1ee0dba8212993eecbe998/,
  );
  assert.match(workflow, /^  build:\n    needs: validate$/m);
});

test("every platform publishes a deterministic checksum manifest", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /npm run release:checksums/);
  assert.match(workflow, /SHA256SUMS-\$\{\{ matrix\.platform \}\}\.txt/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /dist-installers\/SHA256SUMS-\*\.txt/);
});
