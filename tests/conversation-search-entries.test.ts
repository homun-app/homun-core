import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { loadComponent } = require("./helpers/load-component.cjs");
const { describeCron } = await import("../apps/web/src/lib/cadence-language.ts");

const path = "apps/web/src/components/builder/conversation-search-entries.ts";
const { exports: searchModule } = loadComponent(path, {
  spacePeople: [],
  scenarioForWork: () => ({ agent: "Homun" }),
  describeCron: (cron: string) => describeCron(cron),
});

const simulatedRoutine = {
  id: "routine_sim",
  name: "Controllo demo",
  workId: "work_sim",
  schedule: "Ogni lunedì alle 09:00 · Europe/Rome",
  active: true,
};
const engineRoutine = {
  id: "routine_engine_1",
  name: "Verifica listini settimanale",
  cron: "0 9 * * 1",
  cron_timezone: "Europe/Rome",
  conversation_id: "conv_1",
  template: { title: "Verifica listini", objective: "Confronta i listini", plan_steps: [] },
  status: "active",
  last_run_work_id: null,
  last_scheduled_for: null,
  skip_until: null,
  revision: 1,
};

function build(overrides: Record<string, unknown>) {
  const opened: unknown[][] = [];
  const entries = searchModule.buildConversationSearchEntries({
    library: [],
    visibleWorks: [],
    scenarios: [],
    spaceData: { teams: [], projects: [], routines: [simulatedRoutine] },
    workStatus: () => "bozza",
    openSpace: (...args: unknown[]) => opened.push(args),
    openWork: () => {},
    openResultPreview: () => {},
    ...overrides,
  });
  return { entries, opened };
}

test("engine mode: Automazioni entries come only from engine routines and open engine ids", () => {
  const { entries, opened } = build({ engineRoutines: [engineRoutine] });
  const automations = entries.filter((e: { kind: string }) => e.kind === "Automazioni");
  assert.equal(automations.length, 1);
  assert.equal(automations[0].id, "routine_engine_1");
  assert.ok(!entries.some((e: { id: string }) => e.id === "routine_sim"));
  assert.match(automations[0].context, /ogni lunedì alle 9:00/);
  automations[0].open();
  assert.deepEqual(opened, [["Automazioni", "", "routine_engine_1"]]);
});

test("simulation mode: simulated routines still produce their entries", () => {
  const { entries, opened } = build({});
  const automations = entries.filter((e: { kind: string }) => e.kind === "Automazioni");
  assert.equal(automations.length, 1);
  assert.equal(automations[0].id, "routine_sim");
  automations[0].open();
  assert.deepEqual(opened, [["Automazioni", "", "routine_sim"]]);
});

test("engine mode without routines: no Automazioni entries at all", () => {
  const { entries } = build({ engineRoutines: [] });
  assert.equal(entries.filter((e: { kind: string }) => e.kind === "Automazioni").length, 0);
});
