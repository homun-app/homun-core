export function normalizePlanStepStatus(status) {
  return status === "doing" || status === "done" || status === "blocked" ? status : "todo";
}

export function parsePlanSteps(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) return [];
  const out = [];
  for (const raw of markdown.split("\n")) {
    const match = raw.match(/^\-\s*\[(.)\]\s*\*\*(.+?)\*\*\s*(?:\(`([^`]*)`\))?\s*:?\s*(.*)$/);
    if (!match) continue;
    const marker = match[1];
    const status = marker === "x" ? "done" : marker === "-" ? "doing" : marker === "!" ? "blocked" : "todo";
    const id = match[3]?.trim();
    out.push({ status, title: match[2].trim(), detail: match[4].trim(), ...(id ? { id } : {}) });
  }
  return out;
}

export function projectPlanSteps(projection) {
  return (projection?.plan?.steps ?? []).map((step) => ({
    id: step.id,
    title: step.title,
    status: normalizePlanStepStatus(step.status),
    detail: step.detail ?? "",
    ...(step.done_criterion ? { done_criterion: step.done_criterion } : {}),
  }));
}
