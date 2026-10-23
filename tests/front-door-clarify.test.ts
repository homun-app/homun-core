/**
 * Le domande del chiarimento non sono mai JSON per la persona: il modulo puro
 * decodifica ciò che il modello ha incartato (stringa JSON, oggetti
 * concatenati, JSON nel testo della domanda) e lascia il testo piano com'è.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeClarifyQuestions } from "../apps/web/src/lib/front-door-clarify.ts";

const two = [
  { question: "Qual è l'obiettivo?", choices: ["Confronto prezzi", "Panoramica"] },
  { question: "Per quando ti serve?" },
];

test("una stringa JSON con l'elenco diventa domande con le loro scelte", () => {
  const out = normalizeClarifyQuestions([JSON.stringify(two)]);
  assert.deepEqual(out, [
    {
      question: "Qual è l'obiettivo?",
      choices: ["Confronto prezzi", "Panoramica"],
      multi_select: false,
    },
    { question: "Per quando ti serve?", choices: [], multi_select: false },
  ]);
});

test("oggetti o elenchi JSON concatenati (`[…][…]`, `{…}{…}`) diventano domande", () => {
  const lists = JSON.stringify([two[0]]) + JSON.stringify([two[1]]);
  assert.deepEqual(
    normalizeClarifyQuestions([lists]).map((q) => q.question),
    ["Qual è l'obiettivo?", "Per quando ti serve?"],
  );
  const objects = JSON.stringify(two[0]) + "\n" + JSON.stringify(two[1]);
  assert.deepEqual(
    normalizeClarifyQuestions([objects]).map((q) => q.question),
    ["Qual è l'obiettivo?", "Per quando ti serve?"],
  );
});

test("il JSON nascosto nel testo di una domanda strutturata viene decodificato", () => {
  const out = normalizeClarifyQuestions([{ question: JSON.stringify(two), choices: [] }]);
  assert.deepEqual(
    out.map((q) => q.question),
    ["Qual è l'obiettivo?", "Per quando ti serve?"],
  );
  assert.deepEqual(out[0]?.choices, ["Confronto prezzi", "Panoramica"]);
});

test("il testo piano resta com'è e il JSON non valido non viene inventato", () => {
  const out = normalizeClarifyQuestions([
    "Per chi è il documento?",
    { question: "Quando?", choices: ["Oggi"], multi_select: true },
    "[non è json",
    "",
  ]);
  assert.deepEqual(out, [
    { question: "Per chi è il documento?", choices: [], multi_select: false },
    { question: "Quando?", choices: ["Oggi"], multi_select: true },
    { question: "[non è json", choices: [], multi_select: false },
  ]);
});
