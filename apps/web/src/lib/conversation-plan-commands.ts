/**
 * Pure parsers for the simulation plan-editing chat commands
 * ("sposta X dopo Y", "aggiungi X prima di Y con @Nome").
 * Extracted from ConversationWorkspace.send so the shell keeps shrinking.
 */

export type PlanReorder = {
  itemTitle: string;
  relation: "prima" | "dopo";
  anchorTitle: string;
};

export type PlanInsert = {
  rawTitle: string;
  relation: "prima" | "dopo" | undefined;
  rawAnchor: string | undefined;
};

export function parsePlanReorder(text: string): PlanReorder | null {
  const match = text.trim().match(/^sposta\s+(.+?)\s+(prima|dopo)\s+(?:di\s+)?(.+)$/i);
  if (!match) return null;
  return {
    itemTitle: match[1]!,
    relation: match[2]!.toLowerCase() as "prima" | "dopo",
    anchorTitle: match[3]!,
  };
}

export function parsePlanInsert(text: string): PlanInsert | null {
  const match = text
    .trim()
    .match(/^(?:aggiungi|inserisci)\s+(.+?)(?:\s+(prima|dopo)\s+(?:di\s+)?(.+))?$/i);
  if (!match) return null;
  return {
    rawTitle: match[1]!,
    relation: (match[2]?.toLowerCase() as "prima" | "dopo" | undefined) ?? undefined,
    rawAnchor: match[3],
  };
}

/** Strips a trailing "con @Nome" mention from a raw command argument. */
export function stripTrailingMention(value: string): string {
  return value.replace(/\s+(?:con\s+)?@[^@]+$/, "").trim();
}

/** Riordina i passaggi di un piano a partire dal comando "sposta … dopo/prima …".
    Restituisce i passaggi nell'ordine proposto, oppure null se il comando non
    trova due passaggi futuri validi. */
export function reorderPlanSteps<T extends { id: string; title: string }>(
  steps: T[],
  completed: number,
  reorder: PlanReorder,
): T[] | null {
  const from = steps.findIndex((s) =>
    s.title.toLowerCase().includes(reorder.itemTitle.toLowerCase()),
  );
  const target = steps.findIndex((s) =>
    s.title.toLowerCase().includes(reorder.anchorTitle.toLowerCase()),
  );
  if (from < completed || target < completed || from === target) return null;
  const next = steps.filter((_, i) => i !== from);
  const to =
    next.findIndex((s) => s.id === steps[target]!.id) +
    (reorder.relation === "dopo" ? 1 : 0);
  next.splice(to, 0, steps[from]!);
  return next;
}
