import { test } from "node:test";
import assert from "node:assert/strict";
import { componentRenderer } from "./helpers/render-component.ts";

const searchPath = "apps/web/src/components/builder/ConversationSearch.tsx";

test("engine mode footer declares Fonte: motore, with no demo wording", async () => {
  const { render, close } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    const html = render({ entries: [], onClose: () => {}, backend: "engine" });
    assert.match(html, /Fonte: motore/);
    assert.doesNotMatch(html, /dati della demo/);
  } finally {
    await close();
  }
});

test("simulation mode footer declares Fonte: simulazione", async () => {
  const { render, close } = await componentRenderer(searchPath, "ConversationSearch");
  try {
    const html = render({ entries: [], onClose: () => {}, backend: "simulation" });
    assert.match(html, /Fonte: simulazione/);
    assert.doesNotMatch(html, /dati della demo/);
  } finally {
    await close();
  }
});
