/**
 * Pure presentation helpers for versioned intake briefs (Fonte=motore).
 * The engine computes the diff; these functions only translate it to Italian.
 */
import type { WorkIntakeChange } from "./engine-intake-client.ts";

const FIELD_LABELS: Record<string, string> = {
  title: "Titolo",
  objective: "Obiettivo",
  output: "Risultato atteso",
  constraints: "Vincoli",
  capability: "Attività",
  staffing: "Collaboratore",
};

const CAPABILITY_LABELS: Record<string, string> = {
  compare_csv: "Confronto CSV",
  read_material: "Lettura materiale",
  general: "Preparazione",
};

function clip(value: string, max = 80): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function renderValue(field: string, value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return value.length > 0 ? value.map((v) => clip(v, 40)).join(" · ") : "—";
  if (typeof value === "string") {
    if (field === "capability") return CAPABILITY_LABELS[value] ?? value;
    return clip(value);
  }
  return "—";
}

/** One Italian line per actual change, e.g. "Collaboratore: Ada → Bruno". */
export function briefChangeLines(changes: WorkIntakeChange[] | undefined): string[] {
  return (changes ?? []).map((change) => {
    const label = FIELD_LABELS[change.field] ?? change.field;
    return `${label}: ${renderValue(change.field, change.from_value)} → ${renderValue(change.field, change.to_value)}`;
  });
}

/** Names of the agreement fields that stayed identical to the previous brief. */
export function preservedFieldLabels(changes: WorkIntakeChange[] | undefined): string[] {
  const changed = new Set((changes ?? []).map((change) => change.field));
  return ["title", "objective", "output", "constraints", "capability", "staffing"]
    .filter((field) => !changed.has(field))
    .map((field) => FIELD_LABELS[field] ?? field);
}

/**
 * Gate matching the engine rule: an agreement can only be revised while the
 * work is an idle draft (no plan revision, no artifact version).
 */
export function isAgreementRevisable(work: {
  engineStatus?: string;
  enginePlanRevision?: number;
  engineArtifactVersion?: number;
}): boolean {
  return (
    work.engineStatus === "draft" &&
    !work.enginePlanRevision &&
    !work.engineArtifactVersion
  );
}
