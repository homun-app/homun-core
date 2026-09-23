/**
 * Pure presentation helpers for versioned intake briefs (Fonte=motore).
 * The engine computes the diff; these functions only translate it to Italian.
 */
import type { Work } from "@/components/builder/conversation-types";
import type { WorkIntake, WorkIntakeChange } from "./engine-intake-client.ts";

/** Placeholder values the domain uses until an agreement is confirmed. */
export const PLACEHOLDER_WORK_TITLE = "Nuova richiesta";
export const PLACEHOLDER_WORK_OBJECTIVE = "Obiettivo da concordare";

const FIELD_LABELS: Record<string, string> = {
  title: "Titolo",
  objective: "Obiettivo",
  output: "Risultato atteso",
  constraints: "Vincoli",
  capability: "Attività",
  staffing: "Collaboratore",
  plan_steps: "Fasi",
};

const CAPABILITY_LABELS: Record<string, string> = {
  compare_csv: "Confronto CSV",
  read_material: "Lettura materiale",
  synthesize: "Sintesi scritta (modello del collaboratore)",
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
  return ["title", "objective", "output", "constraints", "capability", "staffing", "plan_steps"]
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

/** The one action the person owes while a brief awaits their decision. */
export function isIntakeAwaitingUser(
  proposal: Pick<WorkIntake, "status"> | null | undefined,
): boolean {
  return proposal?.status === "pending_confirmation";
}

/** Same label everywhere an intake can be confirmed: chat card, panel, tasks. */
export function intakeConfirmLabel(
  proposal: Pick<WorkIntake, "new_agent" | "suggested_agent"> | null | undefined,
): string {
  if (!proposal) return "Conferma la proposta";
  if (proposal.new_agent) return "Crea il collaboratore e affida";
  if (proposal.suggested_agent) return "Conferma e affida";
  return "Conferma il riepilogo";
}

/**
 * Display projection while a brief awaits confirmation: the proposal drives
 * title, objective and proposed collaborator until the person decides. The
 * domain record keeps its placeholders; confirm writes the agreed values.
 */
export function applyIntakePreview(work: Work, proposal: WorkIntake): Work {
  if (!isIntakeAwaitingUser(proposal)) {
    // A confirmed brief on a draft work means agreed work in preparation:
    // status chips must not call it "to be agreed" anymore.
    if (proposal.status === "confirmed" && work.engineStatus === "draft") {
      return { ...work, engineIntakeConfirmed: true };
    }
    return work;
  }
  const next: Work = { ...work, engineIntakePending: true };
  if (work.title === PLACEHOLDER_WORK_TITLE) next.title = proposal.title;
  if (!work.engineObjective || work.engineObjective === PLACEHOLDER_WORK_OBJECTIVE) {
    next.engineObjective = proposal.objective;
    next.engineObjectiveProposed = true;
  }
  const agent = proposal.suggested_agent ?? proposal.new_agent;
  if (agent) next.engineProposedAgentName = agent.name;
  return next;
}
