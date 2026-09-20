import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveToolChain,
  listToolChains,
  proposeToolChain,
} from "../apps/web/src/lib/engine-tool-chain-client.ts";
import type { Work } from "../apps/web/src/components/builder/conversation-types.ts";

function work(): Work {
  return {
    id: "work_1",
    engineConversationId: "conv_1",
    scenario: 0,
    title: "Letture",
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

test("chain proposal sends one read step per material with the current revision", async () => {
  const old = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/works")) {
      return Response.json({ items: [{ id: "work_1", version: 7 }] });
    }
    if (String(url).endsWith("/tool-chains") && init?.method === "GET") {
      return Response.json({ items: [] });
    }
    assert.match(String(url), /works\/work_1\/tool-chains$/);
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "ch", status: "pending_approval" });
  };
  try {
    const chain = await proposeToolChain(work(), ["mat_a", "mat_b", "mat_c"], "op1");
    assert.equal(chain.status, "pending_approval");
    assert.deepEqual(bodies[0], {
      command_id: "op1",
      steps: [
        { capability: "read_material", material_id: "mat_a" },
        { capability: "read_material", material_id: "mat_b" },
        { capability: "read_material", material_id: "mat_c" },
      ],
      expected_version: 7,
    });
  } finally {
    globalThis.fetch = old;
  }
});

test("chain approval binds digest and revision; list is typed", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      assert.match(String(url), /tool-chains\/ch\/approve$/);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        command_id: "ok1",
        digest: "bound",
        expected_version: 4,
      });
      return Response.json({ id: "ch", status: "queued" });
    }
    assert.match(String(url), /tool-chains$/);
    return Response.json({ items: [{ id: "ch", status: "completed" }] });
  };
  try {
    const approved = await approveToolChain("work_1", {
      id: "ch",
      digest: "bound",
      expected_version: 4,
    } as never, "ok1");
    assert.equal(approved.status, "queued");
    const items = await listToolChains("work_1");
    assert.equal(items[0].status, "completed");
  } finally {
    globalThis.fetch = old;
  }
});
