const contributionKeys = Object.freeze({
  conversation: "conversation",
  compactedSummary: "compacted_summary",
  filesArtifacts: "files_artifacts",
  authorizedMemory: "authorized_memory",
  systemTools: "system_tools",
});

function nullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function contributionView(value) {
  if (!value || typeof value !== "object") return null;
  const estimatedTokens = nullableNumber(value.estimated_tokens);
  const source = nullableString(value.source);
  if (estimatedTokens === null || source === null) return null;
  return { estimatedTokens, source };
}

export function runtimeContextView(response, selectedNextModel) {
  const source = response && typeof response === "object" ? response : {};
  const usedTokens = nullableNumber(source.used_input_tokens);
  const contextWindow = nullableNumber(source.context_window);
  const percent = usedTokens !== null && contextWindow !== null && contextWindow > 0
    ? Math.min(100, Math.max(0, (usedTokens / contextWindow) * 100))
    : null;
  const rawContributions = source.contributions && typeof source.contributions === "object"
    ? source.contributions
    : {};
  const contributions = {};
  for (const [viewKey, responseKey] of Object.entries(contributionKeys)) {
    contributions[viewKey] = contributionView(rawContributions[responseKey]);
  }

  return {
    effectiveModel: nullableString(source.effective_model),
    selectedNextModel: nullableString(selectedNextModel),
    provider: nullableString(source.provider),
    locality: nullableString(source.locality),
    role: nullableString(source.role),
    contextWindow,
    usedTokens,
    percent,
    contributions,
    compacted: source.compacted === true,
  };
}
