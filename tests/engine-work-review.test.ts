import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewEngineWork } from "../apps/web/src/lib/engine-work-review.ts";

test("correction requires an explicit nonempty comment without issuing a command", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return Response.json({}); };
  try {
    await assert.rejects(async () => reviewEngineWork({ workId: "w", expectedVersion: 4, artifactVersionId: "a", decision: "request_changes", comment: "  " }), { code: "validation_error" });
    assert.equal(called, false);
  } finally { globalThis.fetch = original; }
});

test("correction sends exact artifact, revision and trimmed feedback", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.type, "work.review");
    assert.deepEqual(body.payload, { work_id: "w", expected_version: 4, artifact_version_id: "a", decision: "request_changes", comment: "Correggi le fonti" });
    return Response.json({ result: { status: "ready", version: 5 } });
  };
  try {
    assert.deepEqual(await reviewEngineWork({ workId: "w", expectedVersion: 4, artifactVersionId: "a", decision: "request_changes", comment: " Correggi le fonti " }), { status: "ready", version: 5 });
  } finally { globalThis.fetch = original; }
});
