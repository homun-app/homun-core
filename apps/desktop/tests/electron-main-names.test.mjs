import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The Electron MAIN process had no static checking of any kind: `npm run build` typechecks `src/`, and
// `electron/*.cjs` was checked by nothing. A call to a function that does not exist therefore compiled,
// shipped, and threw a ReferenceError at runtime — and since the code that handles failures is the code
// that runs least, the branches most likely to hide such a typo are precisely the ones no one exercises.
// That is not hypothetical: a `log(...)` that should have been `desktopLog.log(...)`, inside the handler
// that reports a REFUSED system notification, crashed the main process the first time the OS said no.
//
// This test closes that class. It runs TypeScript's `checkJs` over the shell and fails on TS2304 —
// "Cannot find name 'x'" — only. Deliberately narrow: full type inference over untyped CommonJS
// produces a lot of structural noise, and a gate that cries wolf gets ignored. Names that don't exist
// are never noise.
test("the Electron main process references no undefined names", () => {
  let output = "";
  try {
    execFileSync("npx", ["tsc", "-p", "tsconfig.electron.json"], {
      cwd: desktopDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // tsc exits non-zero when it reports ANY diagnostic; we only care about one code.
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const undefinedNames = output
    .split("\n")
    .filter((line) => line.includes("error TS2304"));
  assert.deepEqual(
    undefinedNames,
    [],
    `undefined name(s) in the Electron main process:\n${undefinedNames.join("\n")}`,
  );
});
