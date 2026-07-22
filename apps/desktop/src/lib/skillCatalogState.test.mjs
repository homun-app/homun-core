import assert from "node:assert/strict";
import test from "node:test";

import { catalogIdentity, catalogInstallState } from "./skillCatalogState.mjs";

const weather = (owner_handle) => ({ slug: "weather", owner_handle });

test("publisher plus slug is the remote identity", () => {
  assert.equal(catalogIdentity(weather("steipete")), "steipete/weather");
  assert.equal(catalogIdentity(weather("lfengwa2")), "lfengwa2/weather");
  assert.equal(catalogIdentity(weather(null)), "weather");
});

test("installed requires exact provenance", () => {
  const installed = [{ id: "weather", source: "clawhub:@steipete/weather" }];
  assert.equal(catalogInstallState(weather("steipete"), installed), "installed");
  assert.equal(catalogInstallState(weather("lfengwa2"), installed), "occupied");
  assert.equal(
    catalogInstallState({ slug: "forecast", owner_handle: "x" }, installed),
    "available",
  );
  assert.equal(
    catalogInstallState(weather(null), [
      { id: "weather", source: "clawhub:weather" },
    ]),
    "installed",
  );
});
