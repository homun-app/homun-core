/**
 * Le schede degli esiti del turno di ingresso, verificate sul rendering reale
 * dei componenti (grafo vite dell'app, senza browser).
 *
 * Invariante: la scheda della proposta mostra Conferma / Modifica / Annulla e
 * il diff della revisione; la modifica passa dalla chat (nessuna chiamata
 diretta a /intake); confermata lascia la traccia, non i bottoni.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { componentRenderer } from "./helpers/render-component.ts";
import type { WorkIntake } from "../apps/web/src/lib/engine-intake-client.ts";

function proposal(overrides: Partial<WorkIntake> = {}): WorkIntake {
  return {
    id: "p1",
    work_id: "w1",
    status: "pending_confirmation",
    expected_version: 3,
    digest: "d",
    title: "Nota operativa rinnovo Rossi",
    objective: "Preparare la nota operativa per il rinnovo del contratto Rossi",
    output: "Nota operativa breve",
    constraints: ["Consegna entro il 15 dicembre"],
    missing_information: [],
    suggested_agent: null,
    new_agent: null,
    rationale: "r",
    capability: "general",
    original_request: "Prepara una nota operativa",
    changed_fields: ["constraints"],
    changes: [
      {
        field: "constraints",
        from_value: ["Consegna entro il 30 novembre"],
        to_value: ["Consegna entro il 15 dicembre"],
      },
    ],
    ...overrides,
  };
}

function intakeState(over: Partial<{ proposal: WorkIntake | null; busy: boolean }> = {}) {
  return {
    proposal: over.proposal ?? null,
    loaded: true,
    busy: over.busy ?? false,
    error: null,
    confirm: async () => {},
    refine: async () => true,
  };
}

test("scheda proposta: Conferma, Modifica e Annulla; il diff della revisione è visibile", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/builder/EngineIntakeCoordinatorCard.tsx",
    "EngineIntakeCoordinatorCard",
  );
  try {
    const markup = ui.render({
      proposal: proposal(),
      intake: intakeState({ proposal: proposal() }),
      onSendMessage: (_text: string) => {},
      onDismiss: () => {},
    });
    assert.match(markup, /Conferma accordo e avvia staffetta operativa/);
    assert.match(markup, /Annulla/);
    assert.match(markup, /Modifica/);
    assert.match(markup, /Cosa cambia rispetto all/);
    assert.match(markup, /Vincoli: Consegna entro il 30 novembre → Consegna entro il 15 dicembre/);
    assert.match(markup, /Restano invariati:/);
  } finally {
    await ui.close();
  }
});

test("senza onSendMessage la modifica indica la chat, non una strada separata", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/builder/EngineIntakeCoordinatorCard.tsx",
    "EngineIntakeCoordinatorCard",
  );
  try {
    const markup = ui.render({
      proposal: proposal(),
      intake: intakeState({ proposal: proposal() }),
    });
    assert.match(markup, /Per modificare l/);
    assert.match(markup, /scrivi in chat/);
    assert.doesNotMatch(markup, /Riprova la proposta/);
  } finally {
    await ui.close();
  }
});

test("proposta confermata: traccia senza bottoni d'azione", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/builder/EngineIntakeCoordinatorCard.tsx",
    "EngineIntakeCoordinatorCard",
  );
  try {
    const confirmed = proposal({ status: "confirmed", changes: [] });
    const markup = ui.render({
      proposal: confirmed,
      intake: intakeState({ proposal: confirmed }),
    });
    assert.match(markup, /ACCORDO CONFERMATO/);
    assert.match(markup, /Nota operativa rinnovo Rossi/);
    assert.doesNotMatch(markup, /Conferma accordo e avvia staffetta/);
    assert.doesNotMatch(markup, /Annulla<\/button>/);
  } finally {
    await ui.close();
  }
});

test("scheda chiarimento del turno: domande con scelte che passano dalla chat", async () => {
  const ui = await componentRenderer(
    "/apps/web/src/components/builder/chat/EngineFrontDoorClarifyCard.tsx",
    "EngineFrontDoorClarifyCard",
  );
  try {
    const markup = ui.render({
      questions: [
        {
          question: "Per quando ti serve?",
          choices: ["Domani", "Entro il 30"],
          multi_select: false,
        },
      ],
      onSendMessage: (_text: string) => {},
    });
    assert.match(markup, /Per quando ti serve\?/);
    assert.match(markup, /Domani/);
    assert.match(markup, /Entro il 30/);
    assert.match(markup, /ogni messaggio passa dalla stessa porta/);
  } finally {
    await ui.close();
  }
});

test("scheda chiarimento: mai JSON grezzo — le domande in una stringa JSON (anche oggetti concatenati) diventano domande e le scelte bottoni", async () => {
  // Invariante (punto 2 del giro): con qwen3.5:4b le domande arrivavano come
  // `[{"question": …, "choices": […]}][{…}]` in UN campo di testo e la scheda
  // le mostrava così. La scheda non disegna mai JSON: decodifica e disegna
  // domande con scelte cliccabili.
  const ui = await componentRenderer(
    "/apps/web/src/components/builder/chat/EngineFrontDoorClarifyCard.tsx",
    "EngineFrontDoorClarifyCard",
  );
  try {
    const raw =
      JSON.stringify([
        { question: "Qual è l'obiettivo?", choices: ["Confronto prezzi", "Panoramica"] },
      ]) + JSON.stringify([{ question: "Per quando ti serve?" }]);
    const markup = ui.render({
      questions: [{ question: raw, choices: [], multi_select: false }],
      onSendMessage: (_text: string) => {},
    });
    assert.match(markup, /Qual è l(?:&#x27;|')obiettivo\?/);
    assert.match(markup, /Per quando ti serve\?/);
    assert.doesNotMatch(
      markup,
      /\[\{|\}\]|(?:&quot;|")question(?:&quot;|")|(?:&quot;|")choices(?:&quot;|")/,
    );
    // Le scelte sono bottoni, non testo.
    assert.match(markup, /<button[^>]*>[^<]*<span[^>]*>Confronto prezzi<\/span>/);
    assert.match(markup, /<button[^>]*>[^<]*<span[^>]*>Panoramica<\/span>/);
    assert.equal((markup.match(/<legend/g) ?? []).length, 2);
  } finally {
    await ui.close();
  }
});
