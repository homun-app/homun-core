import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(mjs|ts|tsx)$/.test(entry.name)) return [];
    if (entry.name === "runtimeLifecycleRetirement.test.mjs") return [];
    return [path];
  });
}

test("legacy turn lifecycle projection is retired from desktop runtime", () => {
  assert.equal(existsSync(join(here, "lifecycle.mjs")), false);
  assert.equal(existsSync(join(here, "lifecycle.ts")), false);

  for (const file of sourceFiles(join(here, ".."))) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /deriveTurnLifecycle|TERMINAL_TURN_STATUSES|TurnLifecycleView/);
  }
});
