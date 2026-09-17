import test from "node:test";
import assert from "node:assert/strict";
import {
  createProposal,
  missingMaterials,
  sampleMaterials,
  sampleResult,
  WORK_EXAMPLES,
} from "../apps/web/src/lib/assisted-work.ts";

test("la richiesta libera non viene classificata per parole chiave", () => {
  const draft = createProposal("Ogni mattina preventivi e calendario per il laboratorio", null);
  assert.equal(draft.exampleId, null);
  assert.equal(draft.need, "Ogni mattina preventivi e calendario per il laboratorio");
  assert.equal(draft.method, "");
  assert.equal(sampleResult(draft), null);
});

test("gli esempi scelti esplicitamente conservano frequenza e metodo specifico", () => {
  for (const example of WORK_EXAMPLES) {
    const draft = createProposal(example.need, example.id);
    assert.equal(draft.frequency, example.frequency);
    assert.equal(draft.method, example.method);
    assert.equal(missingMaterials(draft).length, 2);
    assert.equal(sampleResult(draft), null);
    assert.equal(missingMaterials(sampleMaterials(draft)).length, 0);
    assert.equal(sampleResult(sampleMaterials(draft))?.id, example.id);
  }
});

test("non presenta un risultato precompilato per dati o metodo modificati", () => {
  const draft = sampleMaterials(createProposal("Richieste", "requests"));
  for (const field of ["context", "knowledge", "method", "outcome", "responsibility"] as const) {
    assert.equal(sampleResult({ ...draft, [field]: "Diverso" }), null, field);
  }
});
