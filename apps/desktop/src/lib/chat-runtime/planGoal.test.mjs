import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePlanGoal } from "./planGoal.mjs";

test("extracts the goal from the leading **Goal**: line", () => {
  const markdown = [
    "**Goal**: Prenotare il volo per Berlino",
    "",
    "- [x] **Ricerca voli** (`step_01`): confronto tariffe",
    "- [ ] **Prenotazione** (`step_02`): conferma pagamento",
  ].join("\n");
  assert.equal(parsePlanGoal(markdown), "Prenotare il volo per Berlino");
});

test("extracts the first occurrence when the goal line appears later", () => {
  const markdown = [
    "- [ ] **Setup** (`step_01`): prepara ambiente",
    "",
    "**Goal**: Secondo obiettivo",
  ].join("\n");
  assert.equal(parsePlanGoal(markdown), "Secondo obiettivo");
});

test("keeps only the first goal line when several are present", () => {
  const markdown = "**Goal**: Primo\n\n**Goal**: Secondo";
  assert.equal(parsePlanGoal(markdown), "Primo");
});

test("returns null when the goal line is missing", () => {
  const markdown = "- [x] **Fatto** (`step_01`): tutto ok";
  assert.equal(parsePlanGoal(markdown), null);
});

test("is robust to empty, whitespace-only and malformed goal lines", () => {
  assert.equal(parsePlanGoal(""), null);
  assert.equal(parsePlanGoal("**Goal**:   "), null);
  assert.equal(parsePlanGoal("**Goal** missing colon"), null);
  assert.equal(parsePlanGoal(null), null);
  assert.equal(parsePlanGoal(undefined), null);
});

test("trims surrounding whitespace from the goal text", () => {
  assert.equal(parsePlanGoal("**Goal**:   obiettivo con spazi   "), "obiettivo con spazi");
});
