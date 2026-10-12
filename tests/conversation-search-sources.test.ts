import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { loadComponent } = require("./helpers/load-component.cjs");

const path = "apps/web/src/hooks/useConversationSearchEntries.ts";
const { exports: searchModule } = loadComponent(path, {});

test("engine offline makes the materials source unavailable with the gate error", () => {
  const gateError = new Error("Engine data source selected, but the engine is not connected.");
  // The snapshot projection is cleared while offline, so the probe cannot see
  // the projects it should list: the gate error is the honest reason.
  const source = searchModule.searchMaterialsSource(
    "engine",
    false,
    { items: [], status: "loading" },
    gateError,
  );
  assert.equal(source?.status, "unavailable");
  assert.equal(source?.error, gateError);
});

test("engine online passes the probe state through untouched", () => {
  const probe = { items: [{ id: "m1" }], status: "ok" };
  const source = searchModule.searchMaterialsSource("engine", true, probe, null);
  assert.equal(source?.status, "ok");
  assert.equal(source?.error, undefined);
});

test("engine online propagates a probe failure with its typed error", () => {
  const failure = { items: [], status: "unavailable", error: new Error("permission_denied") };
  const source = searchModule.searchMaterialsSource("engine", true, failure, null);
  assert.equal(source?.status, "unavailable");
  assert.equal(source?.error, failure.error);
});

test("simulation has no engine source to report", () => {
  assert.equal(
    searchModule.searchMaterialsSource("simulation", false, { items: [], status: "ok" }, null),
    null,
  );
});
