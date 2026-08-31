import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const workflowPath = path.resolve(import.meta.dirname, "../../../.github/workflows/build.yml");
const ciWorkflowPath = path.resolve(import.meta.dirname, "../../../.github/workflows/ci.yml");
const packagePath = path.resolve(import.meta.dirname, "../package.json");
const preparePackagePath = path.resolve(import.meta.dirname, "../scripts/prepare-package.mjs");

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
    /rustsec\/audit-check@858dc40f52ca2b8570b7a997c1c4e35c6fc9a432/,
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

test("package preparation has a bounded CI timeout", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /- name: Prepare resources \(vite build \+ gateway release binary\)\n\s+working-directory: apps\/desktop\n\s+timeout-minutes: \d+\n\s+run: npm run package:prepare/,
  );
});

test("CI and packaging use the same supported Node runtime", async () => {
  const workflows = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(ciWorkflowPath, "utf8"),
  ]);

  for (const workflow of workflows) {
    assert.doesNotMatch(workflow, /node-version:\s*(?:"?20"?)/);
    assert.match(workflow, /node-version:\s*24/);
  }
});

test("package preparation copies Cargo binaries from Cargo's resolved target directory", async () => {
  const prepare = await readFile(preparePackagePath, "utf8");

  assert.match(prepare, /"metadata",\s*"--format-version",\s*"1",\s*"--no-deps"/);
  assert.match(prepare, /target_directory/);
  assert.doesNotMatch(
    prepare,
    /join\(repoRoot,\s*"target",\s*"release"/,
    "package preparation must not assume Cargo writes under repoRoot/target",
  );
});

test("package smoke uses the configured Cargo target directory", async () => {
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const packageSmoke = pkg.scripts["package:smoke"];

  assert.match(packageSmoke, /CARGO_TARGET_DIR/);
  assert.match(packageSmoke, /package:prepare -- --skip-build/);
});
