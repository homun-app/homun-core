import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { resolveAppVersion } = require("../electron/app-version.cjs");

test("development reports the Homun package version instead of Electron", () => {
  assert.equal(
    resolveAppVersion({
      isPackaged: false,
      electronVersion: "42.2.0",
      packageVersion: "0.1.1094",
    }),
    "0.1.1094",
  );
});

test("packaged builds keep Electron's release version", () => {
  assert.equal(
    resolveAppVersion({
      isPackaged: true,
      electronVersion: "0.1.1094",
      packageVersion: "0.1.1094",
    }),
    "0.1.1094",
  );
});
