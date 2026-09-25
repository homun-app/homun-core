import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatClarifyAnswers,
  parseClarifyNeed,
} from "../apps/web/src/lib/engine-clarify-parser.ts";

test("parseClarifyNeed parses single structured question JSON with choices and recommended", () => {
  const json = JSON.stringify({
    question: "Quale formato di output preferisci?",
    choices: ["PDF report (Consigliato)", "Excel foglio", "CSV grezzo"],
    multi_select: false,
  });

  const result = parseClarifyNeed(json);
  assert.equal(result.isStructured, true);
  assert.equal(result.questions.length, 1);

  const q = result.questions[0]!;
  assert.equal(q.question, "Quale formato di output preferisci?");
  assert.equal(q.multiSelect, false);
  assert.equal(q.choices.length, 3);
  assert.equal(q.choices[0]!.text, "PDF report");
  assert.equal(q.choices[0]!.isRecommended, true);
  assert.equal(q.choices[1]!.text, "Excel foglio");
  assert.equal(q.choices[1]!.isRecommended, false);
});

test("parseClarifyNeed parses batch questions JSON with multi-select", () => {
  const json = JSON.stringify({
    title: "Chiarimenti su requisiti",
    questions: [
      {
        id: "q_format",
        question: "Quali formati esportare?",
        choices: ["PDF", "CSV (Consigliato)"],
        multi_select: true,
      },
      {
        id: "q_detail",
        question: "Includere i dettagli dei prezzi singoli?",
        choices: ["Sì [Consigliato]", "No"],
        multi_select: false,
      },
    ],
  });

  const result = parseClarifyNeed(json);
  assert.equal(result.isStructured, true);
  assert.equal(result.header, "Chiarimenti su requisiti");
  assert.equal(result.questions.length, 2);
  assert.equal(result.questions[0]!.multiSelect, true);
  assert.equal(result.questions[0]!.choices[1]!.isRecommended, true);
  assert.equal(result.questions[1]!.choices[0]!.isRecommended, true);
});

test("parseClarifyNeed parses text with bulleted choices and extracts recommendations", () => {
  const text = `Scegli la modalità di aggregazione:
- Settimanale (Consigliato)
- Mensile
- Trimestrale`;

  const result = parseClarifyNeed(text);
  assert.equal(result.isStructured, true);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0]!.choices.length, 3);
  assert.equal(result.questions[0]!.choices[0]!.text, "Settimanale");
  assert.equal(result.questions[0]!.choices[0]!.isRecommended, true);
  assert.equal(result.questions[0]!.choices[1]!.text, "Mensile");
  assert.equal(result.questions[0]!.choices[1]!.isRecommended, false);
});

test("parseClarifyNeed falls back to unstructured for plain text question", () => {
  const text = "Inserisci l'intervallo temporale di interesse.";
  const result = parseClarifyNeed(text);
  assert.equal(result.isStructured, false);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0]!.question, text);
  assert.equal(result.questions[0]!.choices.length, 0);
});

test("formatClarifyAnswers formats selections and custom notes into readable response", () => {
  const clarify = {
    questions: [
      {
        id: "q_1",
        question: "Formato",
        choices: [{ text: "PDF", raw: "PDF", isRecommended: true }],
        multiSelect: false,
      },
      {
        id: "q_2",
        question: "Dettaglio",
        choices: [{ text: "Completo", raw: "Completo", isRecommended: false }],
        multiSelect: false,
      },
    ],
    isStructured: true,
  };

  const formatted = formatClarifyAnswers(
    clarify,
    { q_1: ["PDF"], q_2: ["Completo"] },
    "Considerare solo dati confermati.",
  );

  assert.match(formatted, /- \*\*Formato\*\*: PDF/);
  assert.match(formatted, /- \*\*Dettaglio\*\*: Completo/);
  assert.match(formatted, /Note aggiuntive: Considerare solo dati confermati\./);
});
