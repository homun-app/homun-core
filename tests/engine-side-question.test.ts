import assert from "node:assert/strict";
import { test } from "node:test";
import { askEngineSideQuestion } from "../apps/web/src/lib/engine-side-question.ts";

test("askEngineSideQuestion throws descriptive error if no runs exist", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ items: [] });
  try {
    await assert.rejects(
      async () => await askEngineSideQuestion("work_1", "a che punto sei?"),
      /Nessuna esecuzione attiva o recente trovata/,
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("askEngineSideQuestion routes to active running execution and returns answer", async () => {
  const oldFetch = globalThis.fetch;
  let sideCalled = false;

  globalThis.fetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/agent-runs")) {
      return Response.json({
        items: [
          { id: "run_past", status: "completed" },
          { id: "run_active", status: "running" },
        ],
      });
    }
    if (urlStr.includes("/agent-runs/run_active/side-question")) {
      sideCalled = true;
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.question, "quali fonti stai leggendo?");
      return Response.json({
        answer: "Sto consultando il listino prezzi 2026.",
        usage: { prompt_tokens: 10, completion_tokens: 12 },
        run_id: "run_active",
        work_id: "work_1",
        main_transcript_unchanged: true,
      });
    }
    throw new Error(`Unexpected fetch to: ${urlStr}`);
  };

  try {
    const res = await askEngineSideQuestion("work_1", "quali fonti stai leggendo?");
    assert.equal(sideCalled, true);
    assert.equal(res.answer, "Sto consultando il listino prezzi 2026.");
    assert.equal(res.main_transcript_unchanged, true);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
