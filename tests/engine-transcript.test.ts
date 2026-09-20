import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEngineTranscript } from "../apps/web/src/lib/engine-transcript-client.ts";

test("durable transcript crosses denied pages, preserves order and sends actor", async () => {
  const previous = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("X-Homun-Actor-Id"), "person_fabio");
    return Response.json(
      urls.length === 1
        ? { items: [], cursor: 12, has_more: true }
        : {
            items: [
              { id: "m1", author_id: "person_fabio", text: "Blu", sequence: 13 },
              { id: "m2", author_id: "homun_engine", text: "Confermato", sequence: 14 },
            ],
            cursor: 14,
            has_more: false,
          },
    );
  };
  try {
    const items = await loadEngineTranscript("conv");
    assert.deepEqual(
      items.map((m) => [m.who, m.text]),
      [
        ["you", "Blu"],
        ["agent", "Confermato"],
      ],
    );
    assert.match(urls[1], /after=12/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("revoked history and stalled pagination fail explicitly", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({ detail: { code: "permission_denied", message: "Revoked" } }, { status: 403 });
    await assert.rejects(loadEngineTranscript("conv"), { code: "permission_denied" });
    globalThis.fetch = async () => Response.json({ items: [], cursor: 0, has_more: true });
    await assert.rejects(loadEngineTranscript("conv"), { code: "validation_error" });
  } finally {
    globalThis.fetch = previous;
  }
});

test("reload preserves annotations only for authorized matching message IDs", async () => {
  const { mergeTranscriptAnnotations } =
    await import("../apps/web/src/lib/engine-transcript-client.ts");
  const current = [{ engineMessageId: "kept", who: "agent" as const, text: "Original" }];
  const previous = [
    {
      engineMessageId: "kept",
      who: "agent" as const,
      text: "Local decoration",
      memorySaved: true,
      patchResolved: "applied" as const,
    },
    { engineMessageId: "revoked", who: "agent" as const, text: "Secret", memorySaved: true },
  ];
  assert.deepEqual(mergeTranscriptAnnotations(current, previous), [
    { ...current[0], memorySaved: true, patchResolved: "applied" },
  ]);
});

test("explicit empty durable history is not replaced by a fabricated assistant message", async () => {
  const { engineWorkToUiWork } = await import("../apps/web/src/lib/conversation-engine-bridge.ts");
  assert.deepEqual(
    engineWorkToUiWork(
      {
        id: "w",
        title: "Work",
        objective: "Objective",
        status: "draft",
        version: 1,
        primary_conversation_id: "conv",
      },
      [],
    ).messages,
    [],
  );
});

test("historical patch text survives but stale approval controls do not", async () => {
  const { currentTranscriptActions } =
    await import("../apps/web/src/lib/engine-transcript-client.ts");
  const message = {
    who: "agent" as const,
    text: "Change proposed",
    patchProposal: { work_id: "w", base_version: 1, changes: [], summary_lines: [] },
  };
  assert.equal(currentTranscriptActions([message], 1)[0]?.patchProposal, message.patchProposal);
  assert.deepEqual(currentTranscriptActions([message], 2), [
    { who: "agent", text: "Change proposed" },
  ]);
});
