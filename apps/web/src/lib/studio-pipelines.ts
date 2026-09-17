import { reconcileDeliveries } from "./studio-handoffs.ts";
import type { AssignedWork } from "../components/builder/StudioToday";
export type ProcedureStep = {
  id: string;
  title: string;
  person: string;
  materials: string;
  approval: boolean;
  approver?: string | undefined;
  training?: AssignedWork["training"];
  method?: string[];
  files?: File[] | undefined;
  materialLinks?: AssignedWork["materialLinks"];
  materialReferences?: string[] | undefined;
  successCriteria?: string | undefined;
  costLimit?: number | undefined;
  costPolicy?: AssignedWork["costPolicy"];
};
export type Procedure = {
  id: string;
  name: string;
  project: string;
  trigger: "manual" | "schedule" | "interval" | "event";
  time: string;
  days: string[];
  interval: number;
  from?: string;
  until?: string;
  event: string;
  active: boolean;
  steps: ProcedureStep[];
};
export function procedureIssue(p: Procedure): string {
  if (!p.name.trim()) return "Dai un nome alla procedura.";
  if (!p.steps.length || p.steps.some((s) => !s.title.trim() || !s.person))
    return "Ogni passaggio richiede un’attività e un responsabile.";
  if (
    p.steps.some(
      (s) => s.costLimit !== undefined && (!Number.isFinite(s.costLimit) || s.costLimit < 0),
    )
  )
    return "Il limite di costo deve essere un numero positivo o zero.";
  if (p.trigger === "schedule" && (!p.time || !p.days.length))
    return "Scegli un orario e almeno un giorno.";
  if (p.trigger === "interval" && (!Number.isFinite(p.interval) || p.interval < 5))
    return "L’intervallo minimo è 5 minuti.";
  if (p.trigger === "interval" && (!p.days.length || (p.from || "09:00") >= (p.until || "18:00")))
    return "Scegli almeno un giorno e una fascia oraria valida.";
  if (p.trigger === "event" && !p.event.trim()) return "Descrivi l’evento che avvia il lavoro.";
  return "";
}
export function procedureTrigger(p: Procedure) {
  if (p.trigger === "manual") return "Su richiesta";
  if (p.trigger === "event") return "Quando: " + p.event;
  if (p.trigger === "interval")
    return `Ogni ${p.interval} minuti · ${p.days.join(", ")} · ${p.from || "09:00"}–${p.until || "18:00"}`;
  return `${p.days.join(", ")} alle ${p.time}`;
}
export function createProcedureRun(p: Procedure, runId: string): AssignedWork[] {
  if (procedureIssue(p)) throw new Error(procedureIssue(p));
  return p.steps.map((s, i) => ({
    id: `${runId}-${s.id}`,
    title: s.title,
    ...(s.training ? { training: { ...s.training } } : {}),
    files: [...(s.files || [])],
    materialLinks: (s.materialLinks || []).map((link) => ({ ...link })),
    materialReferences: [...(s.materialReferences || []), ...(s.materials ? [s.materials] : [])],
    successCriteria: s.successCriteria || "",
    ...(s.costLimit !== undefined ? { costLimit: s.costLimit } : {}),
    costPolicy: s.costPolicy || "pause",
    person: s.person,
    approver: s.approver || "user:fabio",
    project: p.project,
    status: i ? "blocked" : "todo",
    procedureId: p.id,
    runId,
    ...(i ? { dependsOn: `${runId}-${p.steps[i - 1]!.id}` } : {}),
    notes: [
      `Procedura: ${p.name} · prova manuale.`,
      ...(s.materials ? [`Materiali richiesti: ${s.materials}`] : []),
    ],
    steps: [
      ...(i
        ? [
            {
              id: "pipeline-gate",
              title: "Ricevere il risultato del passaggio precedente",
              done: false,
              blocker: p.steps[i - 1]!.person.startsWith("user:")
                ? p.steps[i - 1]!.person
                : "bot:" + p.steps[i - 1]!.person,
              reason: p.steps[i - 1]!.title,
            },
          ]
        : []),
      ...(s.method?.length ? s.method : [s.title]).map((title, index) => ({
        id: "execute-" + index,
        title,
        done: false,
      })),
    ],
    rule: {
      trigger: "manual",
      every: 120,
      weekdays: true,
      from: 9,
      until: 17,
      source: "",
      dependency: "",
      needsFile: false,
      approval: s.approval,
      budget: s.costLimit ?? 1,
      runCost: 0.1,
    },
  }));
}
export function reconcileProcedureTasks(tasks: AssignedWork[]): AssignedWork[] {
  const next: AssignedWork[] = reconcileDeliveries(tasks).map((t) => ({
    ...t,
    ...(t.steps ? { steps: t.steps.map((s) => ({ ...s })) } : {}),
  }));
  // Repeat to propagate an upstream reopening through the whole sequence.
  for (let n = 0; n < next.length; n++)
    for (const t of next) {
      if (!t.dependsOn) continue;
      const previous = next.find((p) => p.id === t.dependsOn);
      const ready = previous?.status === "done" && !previous.steps?.some((s) => !s.done);
      const gate = t.steps?.find((s) => s.id === "pipeline-gate");
      if (!gate) continue;
      gate.done = !!ready;
      if (ready) {
        delete gate.blocker;
        delete gate.reason;
      } else {
        gate.blocker = previous?.person.startsWith("user:")
          ? previous.person
          : "bot:" + (previous?.person || "missing");
        gate.reason =
          "Attende il risultato verificato: " + (previous?.title || "passaggio precedente");
      }
      if (!ready) t.status = "blocked";
      else if (t.status === "blocked") t.status = "todo";
    }
  return next;
}
