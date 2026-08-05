import assert from "node:assert/strict";
import test from "node:test";

import {
  contextBudgetCompressionRatio,
  contextBudgetSummary,
} from "./contextBudgetDisplay.mjs";

test("contextBudgetCompressionRatio returns output over input", () => {
  assert.equal(
    contextBudgetCompressionRatio([
      { inputChars: 80, outputChars: 20 },
      { inputChars: 20, outputChars: 5 },
    ]),
    0.25,
  );
});

test("contextBudgetCompressionRatio treats empty input as fully preserved", () => {
  assert.equal(contextBudgetCompressionRatio([{ inputChars: 0, outputChars: 10 }]), 100);
});

test("contextBudgetSummary describes empty budgets", () => {
  assert.equal(contextBudgetSummary([]), "No compression applied.");
});

test("contextBudgetSummary counts compression redactions and token totals", () => {
  assert.equal(
    contextBudgetSummary([
      {
        compressed: true,
        redacted: true,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 30,
        redactionCount: 2,
      },
      {
        compressed: false,
        redacted: false,
        estimatedInputTokens: 50,
        estimatedOutputTokens: 45,
        redactionCount: 0,
      },
    ]),
    "Compressed 1/2 contexts, 150 -> 75 estimated tokens, 2 redactions.",
  );
});
