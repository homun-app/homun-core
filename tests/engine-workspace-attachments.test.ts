import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestWorkAttachments } from "../apps/web/src/lib/engine-workspace-attachments.ts";
import type { Work } from "../apps/web/src/components/builder/conversation-types.ts";

test("ingestWorkAttachments returns empty array if no files provided", async () => {
  const dummyWork: Work = {
    id: "work_1",
    title: "Test work",
    objective: "Test objective",
    phase: "stage",
    source: "engine",
    revision: 1,
    messages: [],
    materials: [],
    activity: [],
  };

  const res = await ingestWorkAttachments(dummyWork, []);
  assert.deepEqual(res, []);
});

test("ingestWorkAttachments uploads files and returns ingested attachments", async () => {
  const oldFetch = globalThis.fetch;
  let uploadCount = 0;

  globalThis.fetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/conversations")) {
      return Response.json({
        items: [
          {
            id: "conv_1",
            project_id: "proj_123",
            version: 1,
          },
        ],
      });
    }
    if (urlStr.includes("/materials/ingest")) {
      uploadCount++;
      return Response.json({
        material_id: `mat_${uploadCount}`,
        title: "test.pdf",
        byte_size: 100,
        sha256: "dummy_sha",
      });
    }
    throw new Error(`Unexpected fetch to: ${urlStr}`);
  };

  try {
    const dummyWork: Work = {
      id: "work_1",
      title: "Test work",
      objective: "Test objective",
      phase: "stage",
      source: "engine",
      revision: 1,
      engineConversationId: "conv_1",
      messages: [],
      materials: [],
      activity: [],
    };

    const dummyFile = new File(["dummy content"], "test.pdf", { type: "application/pdf" });
    const res = await ingestWorkAttachments(dummyWork, [dummyFile]);

    assert.equal(res.length, 1);
    assert.equal(res[0]!.materialId, "mat_1");
    assert.equal(res[0]!.name, "test.pdf");
    assert.equal(uploadCount, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
