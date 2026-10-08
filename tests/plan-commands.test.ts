import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePlanReorder,
  reorderPlanSteps,
} from "../apps/web/src/lib/conversation-plan-commands.ts";

const steps = [
  { id: "1", title: "Preparare la bozza" },
  { id: "2", title: "Tradurre il catalogo" },
  { id: "3", title: "Pubblicare" },
];

test("reorderPlanSteps sposta un passo futuro prima dell'ancora", () => {
  const reorder = parsePlanReorder("Sposta Pubblicare prima di Tradurre il catalogo");
  assert.ok(reorder);
  const next = reorderPlanSteps(steps, 1, reorder);
  assert.deepEqual(
    next?.map((s) => s.id),
    ["1", "3", "2"],
  );
});

test("reorderPlanSteps rifiuta passaggi già conclusi e ancore mancanti", () => {
  const onCompleted = parsePlanReorder("Sposta Preparare la bozza dopo Pubblicare");
  assert.ok(onCompleted);
  assert.equal(reorderPlanSteps(steps, 1, onCompleted), null);
  const missing = parsePlanReorder("Sposta Tradurre il catalogo dopo Nessun passo");
  assert.ok(missing);
  assert.equal(reorderPlanSteps(steps, 0, missing), null);
});
