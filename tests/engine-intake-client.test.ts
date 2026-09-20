import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyWorkIntake,
  confirmWorkIntake,
  listWorkIntakes,
  proposeWorkIntake,
  resolveFirstMessageRoute,
} from "../apps/web/src/lib/engine-intake-client.ts";

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
test("intake preserves complete original request and revision on proposal", async () => {
  const old = globalThis.fetch;
  const text = "Confronta agosto e settembre. Non convertire le valute. Aspetta la conferma.";
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), {
      command_id: "p",
      text,
      expected_version: 1,
    });
    return Response.json({ id: "p", original_request: text });
  };
  try {
    assert.equal((await proposeWorkIntake("work1", text, 1, "p")).original_request, text);
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

test("classification is stateless routing and surfaces typed failures", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /works\/work1\/intake\/classify$/);
    assert.equal(new Headers(init?.headers).get("X-Homun-Actor-Id"), "person_fabio");
    assert.deepEqual(JSON.parse(String(init?.body)), { text: "How much do we usually spend?" });
    return Response.json({ kind: "question", language: "en" });
  };
  try {
    assert.deepEqual(await classifyWorkIntake("work1", "How much do we usually spend?"), {
      kind: "question",
      language: "en",
    });
  } finally {
    globalThis.fetch = async () =>
      Response.json(
        { detail: { code: "provider_unavailable", message: "down" } },
        { status: 503 },
      );
    await assert.rejects(classifyWorkIntake("work1", "testo"), { code: "provider_unavailable" });
    globalThis.fetch = old;
  }
});

test("proposals carry the detected language only when present", async () => {
  const old = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "p" });
  };
  try {
    await proposeWorkIntake("work1", "Compare the lists", 3, "cmd1", undefined, "EN");
    await proposeWorkIntake("work1", "Confronta i listini", 3, "cmd2");
    assert.deepEqual(bodies[0], {
      command_id: "cmd1",
      text: "Compare the lists",
      expected_version: 3,
      language: "EN",
    });
    assert.deepEqual(bodies[1], {
      command_id: "cmd2",
      text: "Confronta i listini",
      expected_version: 3,
    });
  } finally {
    globalThis.fetch = old;
  }
});

test("first-message routing keeps questions in chat and work requests on the intake path", () => {
  // Confirmed agreement: plain chat, no classification needed.
  assert.equal(
    resolveFirstMessageRoute({ hasIntake: true, intakeConfirmed: true, isNewRequest: false }),
    "chat",
  );
  // New "Nuova richiesta" work without classification: propose (today's behavior).
  assert.equal(
    resolveFirstMessageRoute({ hasIntake: false, intakeConfirmed: false, isNewRequest: true }),
    "propose",
  );
  // A question stays a question, on a fresh work or with a pending proposal.
  assert.equal(
    resolveFirstMessageRoute({
      hasIntake: false,
      intakeConfirmed: false,
      isNewRequest: true,
      classification: "question",
    }),
    "chat",
  );
  assert.equal(
    resolveFirstMessageRoute({
      hasIntake: true,
      intakeConfirmed: false,
      isNewRequest: false,
      classification: "question",
    }),
    "chat",
  );
  // Work requests and refinements keep the durable intake path.
  assert.equal(
    resolveFirstMessageRoute({
      hasIntake: false,
      intakeConfirmed: false,
      isNewRequest: true,
      classification: "work_request",
    }),
    "propose",
  );
  assert.equal(
    resolveFirstMessageRoute({
      hasIntake: true,
      intakeConfirmed: false,
      isNewRequest: false,
      classification: "work_request",
    }),
    "propose",
  );
  // Legacy work without intake: plain chat, unchanged.
  assert.equal(
    resolveFirstMessageRoute({ hasIntake: false, intakeConfirmed: false, isNewRequest: false }),
    "chat",
  );
});
