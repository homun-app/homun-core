/**
 * Le schede del turno di ingresso (porta d'ingresso unica, PR 2): un solo
 * componente per tipo di scheda, agganciato al messaggio che l'ha prodotta.
 *
 * Qui la parte pura: quali schede mostrare, su quale messaggio, e quando una
 * scheda non è più azione (confermata, sorpassata, risposta, versione mossa).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { frontDoorCards } from "../apps/web/src/lib/front-door-cards.ts";

const PATCH = {
  work_id: "w",
  base_version: 2,
  changes: [],
  summary_lines: ["Obiettivo: «a» → «b»"],
};

function message(partial: Record<string, unknown>) {
  return { who: "agent" as const, text: "...", ...partial };
}

test("la scheda di proposta si aggancia al messaggio che l'ha prodotta", () => {
  const cards = frontDoorCards({
    messages: [
      { who: "you" as const, text: "Prepara una nota operativa" },
      message({ id: "a1", intakeProposalId: "p1" }),
      message({ id: "a2", text: "Altro messaggio" }),
    ],
    intakeProposal: { id: "p1", status: "pending_confirmation" },
    workVersion: 1,
  });
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], { kind: "agreement", id: "a1", state: "pending" });
});

test("la proposta confermata lascia la traccia, non i bottoni", () => {
  const cards = frontDoorCards({
    messages: [message({ id: "a1", intakeProposalId: "p1" })],
    intakeProposal: { id: "p1", status: "confirmed" },
    workVersion: 2,
  });
  assert.deepEqual(cards, [{ kind: "agreement", id: "a1", state: "confirmed" }]);
});

test("una proposta sorpassata da una più recente non ha scheda", () => {
  const cards = frontDoorCards({
    messages: [message({ id: "a1", intakeProposalId: "p1" })],
    intakeProposal: { id: "p2", status: "pending_confirmation" },
    workVersion: 1,
  });
  assert.deepEqual(cards, []);
});

test("Annulla nasconde la scheda azionabile, non inventa stato nel motore", () => {
  const cards = frontDoorCards({
    messages: [message({ id: "a1", intakeProposalId: "p1" })],
    intakeProposal: { id: "p1", status: "pending_confirmation" },
    workVersion: 1,
    dismissedProposalIds: ["p1"],
  });
  assert.deepEqual(cards, []);
});

test("chiarimento: la scheda con le scelte resta finché la persona non risponde", () => {
  const questions = [
    { question: "Per quando?", choices: ["Domani", "Entro il 30"], multi_select: false },
  ];
  const open = frontDoorCards({
    messages: [
      { who: "you" as const, text: "Crea una relazione" },
      message({ id: "a1", frontDoor: { kind: "clarification", questions } }),
    ],
    intakeProposal: null,
    workVersion: 1,
  });
  assert.deepEqual(open, [{ kind: "clarify", id: "a1", questions }]);

  const answered = frontDoorCards({
    messages: [
      { who: "you" as const, text: "Crea una relazione" },
      message({ id: "a1", frontDoor: { kind: "clarification", questions } }),
      { who: "you" as const, text: "Entro il 30" },
      message({ id: "a2", text: "Perfetto." }),
    ],
    intakeProposal: null,
    workVersion: 1,
  });
  assert.deepEqual(answered, []);
});

test("anteprima di piano: attiva contro la versione corrente, non dopo", () => {
  const base = [message({ id: "a1", patchProposal: PATCH })];
  const active = frontDoorCards({ messages: base, intakeProposal: null, workVersion: 2 });
  assert.equal(active.length, 1);
  assert.equal(active[0].kind, "plan-change");
  assert.equal(
    active[0].kind === "plan-change" && active[0].summaryLines[0],
    PATCH.summary_lines[0],
  );
  assert.deepEqual(
    frontDoorCards({ messages: base, intakeProposal: null, workVersion: 3 }),
    [],
    "versione mossa: l'anteprima è storicizzata",
  );
  assert.deepEqual(
    frontDoorCards({
      messages: base,
      intakeProposal: null,
      workVersion: 2,
      resolvedPatchIds: ["a1"],
    }),
    [],
  );
});

test("i tre tipi convivono, ciascuno sul proprio messaggio", () => {
  const cards = frontDoorCards({
    messages: [
      message({ id: "a1", intakeProposalId: "p1" }),
      { who: "you" as const, text: "grazie" },
      message({
        id: "a2",
        patchProposal: { work_id: "w", base_version: 4, changes: [], summary_lines: ["x"] },
      }),
    ],
    intakeProposal: { id: "p1", status: "pending_confirmation" },
    workVersion: 4,
  });
  assert.deepEqual(
    cards.map((card) => [card.kind, card.id]),
    [
      ["agreement", "a1"],
      ["plan-change", "a2"],
    ],
  );
});
