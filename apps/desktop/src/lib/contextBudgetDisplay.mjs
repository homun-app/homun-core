export function contextBudgetCompressionRatio(budget) {
  const input = budget.reduce((total, item) => total + item.inputChars, 0);
  const output = budget.reduce((total, item) => total + item.outputChars, 0);
  if (input === 0) return 100;
  return output / input;
}

export function contextBudgetSummary(budget) {
  const compressed = budget.filter((item) => item.compressed).length;
  const redacted = budget.reduce((total, item) => total + item.redactionCount, 0);
  const inputTokens = budget.reduce(
    (total, item) => total + item.estimatedInputTokens,
    0,
  );
  const outputTokens = budget.reduce(
    (total, item) => total + item.estimatedOutputTokens,
    0,
  );
  if (budget.length === 0) return "No compression applied.";
  return `Compressed ${compressed}/${budget.length} contexts, ${inputTokens} -> ${outputTokens} estimated tokens, ${redacted} redactions.`;
}
