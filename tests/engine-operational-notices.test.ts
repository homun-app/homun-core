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
    assert.match(offline, /Connessione non disponibile/);
    assert.doesNotMatch(offline, /disabled=""/);
    const recovery = ui.render({ ...props, followups: [{ commandId: "c1", conversationTitle: "Listini", status: "failed", attempts: 3, errorCode: "provider_unavailable" }] });
    assert.match(recovery, /Listini/);
    assert.match(recovery, /recupero automatico è terminato/);
    assert.match(ui.render({ ...props, backend: "simulation", dataSourceSelected: "simulation" }), /Fonte: simulazione/);
  } finally { await ui.close(); }
});
