import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveMaterialRead,
  prepareMaterialRead,
} from "../apps/web/src/lib/engine-material-read-client.ts";
import type { Work } from "../apps/web/src/components/builder/conversation-types.ts";

function work(): Work {
  return {
    id: "work_1",
    engineConversationId: "conv_1",
    scenario: 0,
    title: "Lettura nota",
    phase: "proposal",
    due: "",
    messages: [],
    files: [],
    contribution: "",
    revision: 3,
    feedback: "",
    source: "engine",
  } as Work;
}

test("approval binds digest and revision of the durable read proposal", async () => {
  const old = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /works\/work_1\/material-reads\/read1\/approve$/);
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "read1", status: "queued" });
  };
  try {
    const result = await approveMaterialRead(
      "work_1",
      { id: "read1", digest: "bound", expected_version: 4 } as never,
      "confirm1",
    );
    assert.equal(result.status, "queued");
    assert.deepEqual(bodies[0], {
      command_id: "confirm1",
      digest: "bound",
      expected_version: 4,
    });
  } finally {
    globalThis.fetch = old;
  }
});

test("unreadable or oversized files never reach the engine", async () => {
  const old = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    return Response.json({});
  };
  try {
    await assert.rejects(
      prepareMaterialRead(work(), new File(["x"], "archivio.zip"), "op"),
      { code: "validation_error" },
    );
    await assert.rejects(
      prepareMaterialRead(work(), new File(["x".repeat(3 * 1024 * 1024)], "notes.txt"), "op"),
      { code: "validation_error" },
    );
    await assert.rejects(
      prepareMaterialRead({ ...work(), engineConversationId: undefined }, new File(["x"], "n.txt"), "op"),
      { code: "validation_error" },
    );
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = old;
  }
});
