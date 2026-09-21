import test from "node:test";
import assert from "node:assert/strict";
import * as projects from "../apps/web/src/lib/engine-work-project.ts";
import * as lifecycle from "../apps/web/src/lib/project-materials-lifecycle.ts";
import { HomunClientError } from "../apps/web/src/lib/homun-errors.ts";
import type { Work } from "../apps/web/src/components/builder/conversation-types.ts";

test("reading an unprojected work never posts an ensure command", async () => {
  const requests: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(init?.method ?? "GET");
    return Response.json({items: [{ id: "conv", version: 1, project_id: null }]});
  };
  try {
    assert.equal(await projects.findEngineProjectForWork({engineConversationId: "conv"} as Work), null);
    assert.deepEqual(requests, ["GET"]);
  } finally { globalThis.fetch = original; }
});

test("folder ingestion retains typed failures with file names and continues", async () => {
  const cause = new HomunClientError("storage_unavailable", "Spazio esaurito");
  const files = [new File(["a"], "bad.csv"), new File(["b"], "good.csv")];
  const result = await lifecycle.ingestMaterialFiles(files, async (file) => {
    if (file.name === "bad.csv") throw cause;
    return {materialId: "good", created: true};
  });
  assert.deepEqual(result.addedIds, ["good"]);
  assert.equal(result.failures[0].fileName, "bad.csv");
  assert.equal(result.failures[0].error, cause);
});

test("material changes reach all subscribers and unsubscribe cleanly", () => {
  const observed: string[] = [];
  const off = lifecycle.subscribeMaterialChanges((projectId) => observed.push(projectId));
  lifecycle.notifyMaterialChange("project");
  off();
  lifecycle.notifyMaterialChange("ignored");
  assert.deepEqual(observed, ["project"]);
});

test("a newer request or work switch invalidates pending material loads", () => {
  const guard = lifecycle.createMaterialRequestGuard();
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
  guard.invalidate();
  assert.equal(second(), false);
});
