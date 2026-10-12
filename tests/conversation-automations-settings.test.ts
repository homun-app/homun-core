import { test } from "node:test";
import assert from "node:assert/strict";
import { componentRenderer } from "./helpers/render-component.ts";

const sectionPath = "apps/web/src/components/builder/ConversationAutomationsSettingsSection.tsx";

test("engine mode shows true counts and opens the routines view, with no false promises", async () => {
  const { render, close } = await componentRenderer(
    sectionPath,
    "ConversationAutomationsSettingsSection",
  );
  try {
    const html = render({
      source: "engine",
      activeCount: 2,
      pausedCount: 1,
      onOpenRoutines: () => {},
    });
    assert.match(html, /Fonte: motore/);
    assert.match(html, /2 attiv[ae]/);
    assert.match(html, /1 in pausa/);
    assert.match(html, /Apri Automazioni/);
    assert.doesNotMatch(html, /non è ancora attivo|non ti promettiamo|Cosa arriva/i);
  } finally {
    await close();
  }
});

test("simulation mode declares its source explicitly", async () => {
  const { render, close } = await componentRenderer(
    sectionPath,
    "ConversationAutomationsSettingsSection",
  );
  try {
    const html = render({
      source: "simulation",
      activeCount: 2,
      pausedCount: 1,
      onOpenRoutines: () => {},
    });
    assert.match(html, /Fonte: simulazione/);
    assert.doesNotMatch(html, /Fonte: motore/);
    assert.doesNotMatch(html, /2 attiv[ae]/);
  } finally {
    await close();
  }
});
