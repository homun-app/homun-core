import assert from "node:assert/strict";
import { test } from "node:test";
import {
  briefChangeLines,
  isAgreementRevisable,
  preservedFieldLabels,
} from "../apps/web/src/lib/engine-intake-display.ts";

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
