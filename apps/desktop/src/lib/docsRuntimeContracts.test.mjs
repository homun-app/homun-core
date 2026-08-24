import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../");

function readDoc(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("runtime docs point composer mode at the presenter owner", () => {
  const lifecycleDoc = readDoc("docs/architecture/chat-lifecycle.md");
  const antiRegressionDoc = readDoc("docs/testing/anti-regression-protocol.md");

  assert.match(lifecycleDoc, /runtimeViewModel\.composerMode/);
  assert.match(lifecycleDoc, /submissionRouting\.ts/);
  assert.match(antiRegressionDoc, /kernelProjectionPresenter\.test\.mjs/);
  assert.match(antiRegressionDoc, /submissionRouting\.test\.mjs/);

  assert.doesNotMatch(lifecycleDoc, /chat-runtime\/composerMode\.(?:mjs|ts|test\.mjs)/);
  assert.doesNotMatch(antiRegressionDoc, /chat-runtime\/composerMode\.(?:mjs|ts|test\.mjs)/);
});
