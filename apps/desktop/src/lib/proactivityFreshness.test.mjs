import test from "node:test";
import assert from "node:assert/strict";
import { freshness } from "./proactivityFreshness.mjs";

test("expired cards are hidden and old cards are labelled", () => {
  assert.equal(freshness({ generated_at: 100, relevant_until: 150 }, 151), "expired");
  assert.equal(
    freshness({ generated_at: 100, relevant_until: null }, 100 + 8 * 86400),
    "stale",
  );
});

test("freshness accepts legacy creation timestamps and inclusive expiry", () => {
  assert.equal(freshness({ created_at: 100, relevant_until: 150 }, 150), "fresh");
  assert.equal(freshness({ created_at: 100, relevant_until: null }, 100 + 86400), "fresh");
});
