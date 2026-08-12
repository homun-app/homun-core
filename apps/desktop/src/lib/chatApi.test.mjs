import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "chatApi.ts"), "utf8");

test("desktop chat API exposes only kernel projection for runtime activity", () => {
  assert.match(source, /export interface KernelThreadProjection/);
  assert.match(source, /fetchKernelThreadProjection/);
  assert.doesNotMatch(source, /export interface ThreadActivityProjection/);
  assert.doesNotMatch(source, /fetchThreadActivity/);
  assert.doesNotMatch(source, /\/api\/chat\/threads\/\$\{encodeURIComponent\(threadId\)\}\/activity/);
});
