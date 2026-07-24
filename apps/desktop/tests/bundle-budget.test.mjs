import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "dist", "assets");

test("the eager entry chunk stays within budget", (t) => {
  let files;
  try {
    files = readdirSync(assets);
  } catch {
    t.skip("run `npm run build` first");
    return;
  }
  const entry = files.filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(entry.length, 1, `expected exactly one entry chunk, got ${entry.join(", ")}`);
  const bytes = statSync(join(assets, entry[0])).size;
  // Was 3,567,383 B with every view statically imported. The budget is a ratchet:
  // lower it when a task legitimately shrinks the entry further.
  assert.ok(bytes < 2_600_000, `entry chunk is ${bytes} B, budget is 2,600,000 B`);
});
