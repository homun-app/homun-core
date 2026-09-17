import assert from "node:assert/strict";
import test from "node:test";
import { emptyFirstWorkDraft, prepareDemoWork } from "../apps/web/src/lib/first-work.ts";

const complete = () => ({
  ...emptyFirstWorkDraft(),
  need: "  Verificare la disponibilità dei ricambi  ",
  name: "Lea",
  responsibility: "Confrontare ricambi compatibili",
  title: "Ricambio pompa A",
  outcome: "Tre opzioni documentate",
  method: "Raccogliere i codici\nVerificare la compatibilità\nConfrontare le offerte",
});

test("preserva un caso libero senza convertirlo in un ruolo predefinito", () => {
  const result = prepareDemoWork(complete());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.work.need, "Verificare la disponibilità dei ricambi");
  assert.equal(result.work.responsibility, "Confrontare ricambi compatibili");
  assert.equal(result.work.steps.length, 3);
  assert.equal(result.work.status, "da_fare");
  assert.equal(result.work.cost, null);
  assert.equal(result.work.demo, true);
});

test("non prepara un lavoro con dati essenziali o metodo vuoti", () => {
  for (const field of ["need", "name", "responsibility", "title", "outcome", "method"] as const) {
    assert.equal(prepareDemoWork({ ...complete(), [field]: " \n " }).ok, false, field);
  }
});

test("richiede un limite positivo esplicito prima di consentire modelli remoti", () => {
  for (const budget of ["", "0", "-5", "Infinity", "2abc", "0.001"]) {
    assert.equal(prepareDemoWork({ ...complete(), aiPolicy: "mixed", budget }).ok, false, budget);
  }
  const result = prepareDemoWork({ ...complete(), aiPolicy: "mixed", budget: "2,50" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.work.budgetEuro, 2.5);
});

test("solo locale non abilita budget remoto e il riepilogo è una copia indipendente", () => {
  const draft = { ...complete(), tools: ["files"], budget: "10" };
  const result = prepareDemoWork(draft);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  draft.tools.push("email");
  assert.deepEqual(result.work.tools, ["files"]);
  assert.equal(result.work.budgetEuro, null);
});
