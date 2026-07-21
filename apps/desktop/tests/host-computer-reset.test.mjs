import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { hostComputerStatePaths, performFactoryReset } = require("../electron/lib/factory-reset.cjs");

test("factory reset stops managed processes and removes every host-computer state root", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "homun-reset-test-"));
  const homunRoot = path.join(temporary, ".homun");
  await fs.mkdir(homunRoot, { recursive: true });
  for (const ownedPath of hostComputerStatePaths(homunRoot)) {
    if (path.extname(ownedPath)) {
      await fs.mkdir(path.dirname(ownedPath), { recursive: true });
      await fs.writeFile(ownedPath, "fixture");
    } else {
      await fs.mkdir(ownedPath, { recursive: true });
      await fs.writeFile(path.join(ownedPath, "fixture"), "fixture");
    }
  }
  let stopped = false;
  let storageCleared = false;
  await performFactoryReset({
    homunRoot,
    stopManagedProcesses: async () => { stopped = true; },
    clearStorage: async () => { storageCleared = true; },
  });
  assert.equal(stopped, true);
  assert.equal(storageCleared, true);
  await assert.rejects(fs.stat(homunRoot));
  await fs.rm(temporary, { recursive: true, force: true });
});

test("factory reset refuses broad or unrelated roots", async () => {
  assert.throws(() => hostComputerStatePaths("/"));
  assert.throws(() => hostComputerStatePaths(path.join(os.tmpdir(), "not-homun")));
});
