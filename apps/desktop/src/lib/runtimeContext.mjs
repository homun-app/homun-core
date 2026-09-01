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

function finiteCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function diagnosticGapView(value) {
  if (!value || typeof value !== "object") return null;
  const code = nullableString(value.code);
  const owner = nullableString(value.owner);
  const summary = nullableString(value.summary);
  if (!code || !owner || !summary) return null;
  return {
    code,
    owner,
    summary,
    severity: nullableString(value.severity) ?? "warning",
  };
}

export function runtimeIntegrityView(response, maxVisibleGaps = 4) {
  const source = response && typeof response === "object" ? response : {};
  const runtime = source.runtime && typeof source.runtime === "object" ? source.runtime : {};
  const observability =
    runtime.observability && typeof runtime.observability === "object"
      ? runtime.observability
      : {};
  const summary =
    observability.summary && typeof observability.summary === "object"
      ? observability.summary
      : {};
  const rawGaps = Array.isArray(observability.diagnostic_gaps)
    ? observability.diagnostic_gaps
    : [];
  const diagnosticGaps = rawGaps
    .map(diagnosticGapView)
    .filter(Boolean)
    .slice(0, Math.max(0, maxVisibleGaps));
  const diagnosticGapCount = finiteCount(summary.diagnostic_gaps);
  const integrityOk = runtime.integrity_ok === true;
  const errorCount = finiteCount(runtime.error_count);
  const warningCount = finiteCount(runtime.warning_count);

  return {
    available: Boolean(source.runtime && typeof source.runtime === "object"),
    healthy: integrityOk && diagnosticGapCount === 0,
    integrityOk,
    errorCount,
    warningCount,
    diagnosticGapCount,
    visibleDiagnosticGaps: diagnosticGaps,
    hiddenDiagnosticGapCount: Math.max(0, diagnosticGapCount - diagnosticGaps.length),
  };
}
