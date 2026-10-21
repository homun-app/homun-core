import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmWorkIntake, listWorkIntakes } from "../apps/web/src/lib/engine-intake-client.ts";

test("intake confirmation binds the exact proposal and explicitly opts in to agent creation", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /works\/work1\/intake\/proposal1\/confirm$/);
    assert.equal(new Headers(init?.headers).get("X-Homun-Actor-Id"), "person_fabio");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      command_id: "confirm1",
      digest: "bound",
      expected_version: 2,
      create_agent: true,
    });
    return Response.json({ id: "proposal1", status: "confirmed" });
  };
  try {
    assert.equal(
      (
        await confirmWorkIntake(
          "work1",
          { id: "proposal1", digest: "bound", expected_version: 2 } as never,
          "confirm1",
          true,
        )
      ).status,
      "confirmed",
    );
  } finally {
    globalThis.fetch = old;
  }
});
test("intake transport never masks denied inventory", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { detail: { code: "permission_denied", message: "Access revoked" } },
      { status: 403 },
    );
  try {
    await assert.rejects(listWorkIntakes("work1"), { code: "permission_denied" });
  } finally {
    globalThis.fetch = old;
  }
});

test("renaming is a versioned domain command and never changes the objective", async () => {
  const { renameEngineWork } = await import("../apps/web/src/lib/engine-work-naming.ts");
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.type, "work.rename");
    assert.deepEqual(body.payload, { work_id: "w", title: "Titolo scelto", expected_version: 6 });
    return Response.json({ result: { work_id: "w", version: 7 } });
  };
  try {
    await renameEngineWork("w", "Titolo scelto", 6);
  } finally {
    globalThis.fetch = old;
  }
});
