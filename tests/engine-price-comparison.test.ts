import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvePriceComparison,
  listPriceComparisons,
  preparePriceComparison,
} from "../apps/web/src/lib/engine-price-comparison-client.ts";

test("preparation retry recovers existing proposal without a new revision or upload", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.match(String(url), /price-comparisons$/);
    return Response.json({ items: [{ id: "stable-operation", status: "pending_approval" }] });
  };
  try {
    const result = await preparePriceComparison(
      { id: "w", engineConversationId: "c" } as never,
      new File(["sku;name;price;currency"], "left.csv"),
      new File(["sku;name;price;currency"], "right.csv"),
      "stable-operation",
    );
    assert.equal(result.id, "stable-operation");
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("comparison approval submits exact digest and revision with bound actor", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /works\/w\/price-comparisons\/p\/approve$/);
    assert.equal(new Headers(init?.headers).get("X-Homun-Actor-Id"), "person_fabio");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      command_id: "approval",
      digest: "exact",
      expected_version: 3,
    });
    return Response.json({ id: "p", status: "queued" });
  };
  try {
    await approvePriceComparison(
      "w",
      { id: "p", digest: "exact", expected_version: 3 } as never,
      "approval",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("denied comparison reads fail with typed error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ detail: { code: "permission_denied", message: "Revoked" } }, { status: 403 });
  try {
    await assert.rejects(listPriceComparisons("w"), { code: "permission_denied" });
  } finally {
    globalThis.fetch = original;
  }
});
