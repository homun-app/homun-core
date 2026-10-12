import assert from "node:assert/strict";
import { test } from "node:test";
import { componentRenderer } from "./helpers/render-component.ts";

test("operational notices are quiet when healthy but preserve errors, recovery and simulation identity", async () => {
  const ui = await componentRenderer("/apps/web/src/components/builder/ConversationEngineBanner.tsx", "ConversationEngineBanner");
  const props = { backend: "engine", dataSourceSelected: "engine", gateError: null, error: null, busy: false, workCount: 1, followups: [], onRefresh: () => {} };
  try {
    assert.equal(ui.render(props), "");
    const failure = ui.render({ ...props, error: new Error("Provider non disponibile") });
    assert.match(failure, /role="alert"/);
    const offline = ui.render({ ...props, gateError: new Error("Connessione interrotta") });
    assert.match(offline, /Homun \(motore\) non è raggiungibile/);
    assert.match(offline, /non passiamo alla simulazione/);
    assert.doesNotMatch(offline, /disabled=""/);
    assert.doesNotMatch(offline, /passa alla simulazione/i);
    const recovery = ui.render({ ...props, followups: [{ commandId: "c1", conversationTitle: "Listini", status: "failed", attempts: 3, errorCode: "provider_unavailable" }] });
    assert.match(recovery, /Listini/);
    assert.match(recovery, /recupero automatico è terminato/);
    assert.match(ui.render({ ...props, backend: "simulation", dataSourceSelected: "simulation" }), /Fonte: simulazione/);
  } finally { await ui.close(); }
});

test("the workspace shell declares simulation in exactly one stable point, and says nothing in engine mode", async () => {
  const ui = await componentRenderer("/apps/web/src/components/builder/ConversationWorkspaceEngineNotices.tsx", "ConversationWorkspaceEngineNotices");
  const engineState = (over: Record<string, unknown>) => ({
    dataSource: "engine",
    backend: "engine",
    gateError: null,
    error: null,
    busy: false,
    works: [],
    followups: [],
    refresh: () => {},
    ...over,
  });
  try {
    // Simulation: the one visible label, rendered on every space of the shell.
    const simulation = ui.render({ engine: engineState({ dataSource: "simulation", backend: "simulation" }), onOpenModels: () => {} });
    assert.match(simulation, /Fonte: simulazione/);
    // Engine mode healthy: no label at all — the engine is the non-simulation default.
    assert.equal(ui.render({ engine: engineState(), onOpenModels: () => {} }), "");
    // Engine mode offline keeps the operational banner, never the simulation label.
    const offline = ui.render({
      engine: engineState({ gateError: new Error("Engine data source selected, but the engine is not connected.") }),
      onOpenModels: () => {},
    });
    assert.match(offline, /Homun \(motore\) non è raggiungibile/);
    assert.doesNotMatch(offline, /Fonte: simulazione/);
  } finally { await ui.close(); }
});
