import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyIntakePreview,
  briefChangeLines,
  intakeConfirmLabel,
  isAgreementRevisable,
  isIntakeAwaitingUser,
  PLACEHOLDER_WORK_OBJECTIVE,
  PLACEHOLDER_WORK_TITLE,
  preservedFieldLabels,
} from "../apps/web/src/lib/engine-intake-display.ts";
import type { Work } from "../apps/web/src/components/builder/conversation-types.ts";
import type { WorkIntake } from "../apps/web/src/lib/engine-intake-client.ts";

function draftWork(): Work {
  return {
    id: "work_1",
    title: PLACEHOLDER_WORK_TITLE,
    scenario: 0,
    phase: "proposal",
    due: "",
    messages: [],
    files: [],
    contribution: "",
    revision: 3,
    feedback: "",
    source: "engine",
    engineObjective: PLACEHOLDER_WORK_OBJECTIVE,
  };
}

function proposal(overrides: Partial<WorkIntake> = {}): WorkIntake {
  return {
    id: "intake_1",
    work_id: "work_1",
    status: "pending_confirmation",
    expected_version: 3,
    digest: "d",
    title: "Confronto listini marzo e aprile",
    objective: "Confrontare i prezzi dei due listini e riportare le differenze",
    output: "Report con le differenze",
    constraints: [],
    missing_information: [],
    suggested_agent: null,
    new_agent: { name: "Aurora", role: "Analisi prezzi", instructions: "…" },
    rationale: "…",
    capability: "compare_csv",
    original_request: "…",
    ...overrides,
  };
}

test("brief changes are rendered as compact Italian lines", () => {
  const lines = briefChangeLines([
    { field: "staffing", from_value: "Ada", to_value: "Bruno" },
    { field: "capability", from_value: "general", to_value: "compare_csv" },
    { field: "objective", from_value: "Obiettivo vecchio", to_value: "Obiettivo nuovo" },
    { field: "constraints", from_value: [], to_value: ["Nessuna conversione valutaria"] },
  ]);
  assert.deepEqual(lines, [
    "Collaboratore: Ada → Bruno",
    "Attività: Preparazione → Confronto CSV",
    "Obiettivo: Obiettivo vecchio → Obiettivo nuovo",
    "Vincoli: — → Nessuna conversione valutaria",
  ]);
});

test("missing values and long text stay readable", () => {
  const [line] = briefChangeLines([{ field: "staffing", from_value: null, to_value: "Analista Prezzi" }]);
  assert.equal(line, "Collaboratore: — → Analista Prezzi");
  const [long] = briefChangeLines([
    {
      field: "objective",
      from_value: "x".repeat(120),
      to_value: "y".repeat(120),
    },
  ]);
  assert.ok(long.length < 200, long);
});

test("preserved fields are everything the engine did not change", () => {
  assert.deepEqual(
    preservedFieldLabels([{ field: "staffing", from_value: "Ada", to_value: "Bruno" }]),
    ["Titolo", "Obiettivo", "Risultato atteso", "Vincoli", "Attività"],
  );
  assert.deepEqual(preservedFieldLabels([]), [
    "Titolo",
    "Obiettivo",
    "Risultato atteso",
    "Vincoli",
    "Attività",
    "Collaboratore",
  ]);
  assert.deepEqual(preservedFieldLabels(undefined), [
    "Titolo",
    "Obiettivo",
    "Risultato atteso",
    "Vincoli",
    "Attività",
    "Collaboratore",
  ]);
});

test("an agreement is revisable only on an idle engine draft", () => {
  assert.equal(isAgreementRevisable({ engineStatus: "draft" }), true);
  assert.equal(
    isAgreementRevisable({ engineStatus: "draft", enginePlanRevision: 0, engineArtifactVersion: 0 }),
    true,
  );
  assert.equal(isAgreementRevisable({ engineStatus: "draft", enginePlanRevision: 2 }), false);
  assert.equal(isAgreementRevisable({ engineStatus: "draft", engineArtifactVersion: 1 }), false);
  assert.equal(isAgreementRevisable({ engineStatus: "review" }), false);
  assert.equal(isAgreementRevisable({}), false);
});

test("a pending brief drives the work display until it is confirmed", () => {
  const next = applyIntakePreview(draftWork(), proposal());
  assert.equal(next.title, "Confronto listini marzo e aprile");
  assert.equal(next.engineObjective, "Confrontare i prezzi dei due listini e riportare le differenze");
  assert.equal(next.engineIntakePending, true);
  assert.equal(next.engineObjectiveProposed, true);
  assert.equal(next.engineProposedAgentName, "Aurora");
});

test("manual renames and agreed values are never overwritten by the preview", () => {
  const renamed = { ...draftWork(), title: "Il mio titolo", engineObjective: "Obiettivo concordato" };
  const next = applyIntakePreview(renamed, proposal());
  assert.equal(next.title, "Il mio titolo");
  assert.equal(next.engineObjective, "Obiettivo concordato");
  assert.equal(next.engineObjectiveProposed, undefined);
  const confirmed = applyIntakePreview({ ...draftWork(), engineStatus: "draft" }, proposal({ status: "confirmed" }));
  assert.equal(confirmed.title, PLACEHOLDER_WORK_TITLE);
  assert.equal(confirmed.engineIntakePending, undefined);
  // An agreed draft is preparation, not a stale proposal: the status chip
  // must be able to tell the two apart.
  assert.equal(confirmed.engineIntakeConfirmed, true);
});

test("confirm label names the decision the person is making", () => {
  assert.equal(intakeConfirmLabel(proposal()), "Crea il collaboratore e affida");
  assert.equal(
    intakeConfirmLabel(proposal({ new_agent: null, suggested_agent: { id: "a", name: "Ada", role: "R", revision: 1 } })),
    "Conferma e affida",
  );
  assert.equal(intakeConfirmLabel(proposal({ new_agent: null })), "Conferma il riepilogo");
  assert.equal(intakeConfirmLabel(null), "Conferma la proposta");
  assert.equal(isIntakeAwaitingUser(proposal()), true);
  assert.equal(isIntakeAwaitingUser(proposal({ status: "confirmed" })), false);
  assert.equal(isIntakeAwaitingUser(null), false);
});
