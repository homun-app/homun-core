import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyFreshRequest,
  routeEngineFirstMessage,
} from "../apps/web/src/lib/engine-first-message-routing.ts";
import type { Work } from "../apps/web/src/components/builder/conversation-types.ts";

function work(over: Partial<Work>): Work {
  return {
    id: "work_1",
    scenario: 0,
    title: "Nuova richiesta",
    phase: "proposal",
    due: "",
    messages: [],
    files: [],
    contribution: "",
    revision: 1,
    feedback: "",
    source: "engine",
    ...over,
  } as Work;
}

function mockFetch(calls: Array<(url: string) => Response>) {
  const seen: string[] = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const handler = calls[Math.min(seen.length - 1, calls.length - 1)];
    return handler(String(url));
  };
  return {
    restore: () => {
      globalThis.fetch = old;
    },
    seen,
  };
}

const intakeList = (status: string) => () =>
  Response.json({ items: [{ id: "i1", status }] });
const classify = (kind: string) => () => Response.json({ kind });
const classifyJson = (body: unknown) => () => Response.json(body);
const unavailable = () =>
  Response.json({ detail: { code: "provider_unavailable", message: "down" } }, { status: 503 });

test("a confirmed agreement routes messages straight to chat without classification", async () => {
  const mock = mockFetch([intakeList("confirmed"), classify("question")]);
  try {
    assert.deepEqual(await routeEngineFirstMessage(work({}), "una qualsiasi"), { route: "chat" });
    assert.equal(mock.seen.filter((url) => url.includes("/classify")).length, 0);
  } finally {
    mock.restore();
  }
});

test("an open question on a fresh work stays in the conversation", async () => {
  const mock = mockFetch([intakeList("failed"), classifyJson({ kind: "question", language: "en" })]);
  try {
    assert.deepEqual(
      await routeEngineFirstMessage(work({}), "How much do we usually spend on supplies?"),
      { route: "chat", language: "en" },
    );
    assert.equal(mock.seen.filter((url) => url.includes("/classify")).length, 1);
  } finally {
    mock.restore();
  }
});

test("a work request keeps the durable intake path and carries the detected language", async () => {
  const mock = mockFetch([intakeList("failed"), classifyJson({ kind: "work_request", language: "en" })]);
  try {
    assert.deepEqual(
      await routeEngineFirstMessage(work({}), "Compare the March and April price lists"),
      { route: "propose", language: "en" },
    );
  } finally {
    mock.restore();
  }
});

test("classification failures fall back to the proposal path, never silently to chat", async () => {
  const mock = mockFetch([intakeList("failed"), unavailable()]);
  try {
    assert.deepEqual(await routeEngineFirstMessage(work({}), "Qualsiasi cose"), { route: "propose" });
  } finally {
    mock.restore();
  }
});

test("legacy works without intake keep plain chat, with no extra roundtrip", async () => {
  const mock = mockFetch([intakeList("confirmed")]);
  try {
    assert.deepEqual(
      await routeEngineFirstMessage(work({ title: "Confronto listini · demo" }), "ciao"),
      { route: "chat" },
    );
    assert.equal(mock.seen.filter((url) => url.includes("/classify")).length, 0);
  } finally {
    mock.restore();
  }
});

test("a fresh work's first message routes through classification", async () => {
  const mock = mockFetch([classifyJson({ kind: "question", language: "it" })]);
  try {
    assert.deepEqual(
      await classifyFreshRequest("work_new", "Quanto spendiamo di solito? È solo una curiosità."),
      { route: "chat", language: "it" },
    );
  } finally {
    mock.restore();
  }
  const mock2 = mockFetch([classifyJson({ kind: "work_request" })]);
  try {
    assert.deepEqual(await classifyFreshRequest("work_new", "Confronta i due listini"), {
      route: "propose",
    });
  } finally {
    mock2.restore();
  }
  const mock3 = mockFetch([unavailable()]);
  try {
    assert.deepEqual(
      await classifyFreshRequest("work_new", "Qualsiasi testo con il modello giù"),
      { route: "propose" },
    );
  } finally {
    mock3.restore();
  }
});
