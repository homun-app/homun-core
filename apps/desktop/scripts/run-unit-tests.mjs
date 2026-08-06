#!/usr/bin/env node
/**
 * Umbrella desktop unit-test route.
 *
 * Discovers every `*.test.mjs` file by convention (recursively under `src`,
 * `tests`, `electron`, and `scripts`) and runs them with `node --test`, so
 * new test files join the route without editing any enumerated list. Gates
 * (`scripts/pre_release_gate.py`, `scripts/kernel_regression_gate.py`) and
 * local runs must consume this route via `npm test`.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_ROOTS = ["src", "tests", "electron", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-installers",
  ".package",
  ".git",
]);
const TEST_SUFFIX = ".test.mjs";

function discoverTests(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...discoverTests(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

export function collectTestFiles() {
  const files = SEARCH_ROOTS.flatMap((name) => discoverTests(join(ROOT, name)));
  return files.sort((a, b) => relative(ROOT, a).localeCompare(relative(ROOT, b)));
}

function main(argv) {
  const files = collectTestFiles();
  if (files.length === 0) {
    console.error("run-unit-tests: no *.test.mjs files discovered under apps/desktop");
    return 1;
  }
  if (argv.includes("--list")) {
    for (const file of files) console.log(relative(ROOT, file));
    return 0;
  }
  console.log(`run-unit-tests: discovered ${files.length} test files`);
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error);
    return 1;
  }
  return result.status ?? 1;
}

if (resolve(process.argv[1] ?? "") === resolve(dirname(fileURLToPath(import.meta.url)), "run-unit-tests.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
