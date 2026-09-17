import type { AssignedWork } from "../components/builder/StudioToday";
export const workStates = {
  todo: "Da fare",
  doing: "In corso",
  blocked: "In attesa",
  review: "Da approvare",
  done: "Completato",
};
export const dateKey = (date: Date) =>
  date.getFullYear() +
  "-" +
  String(date.getMonth() + 1).padStart(2, "0") +
  "-" +
  String(date.getDate()).padStart(2, "0");
export const workDate = (value?: string) =>
  value
    ? new Date(value).toLocaleString("it-IT", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Senza scadenza";
export const statusOf = (task: AssignedWork) =>
  task.steps?.some((s) => !s.done && s.blocker) ? "blocked" : task.status || "todo";

export function triggerLabel(task: AssignedWork): string {
  const rule = task.rule;
  if (!rule || rule.trigger === "manual") return "Avvio manuale";
  if (rule.trigger === "event") return "Quando: " + rule.source;
  if (rule.trigger === "task") return "Dopo il completamento del lavoro collegato";
  return `Ogni ${rule.every} minuti · ${rule.weekdays ? "lun–ven" : "tutti i giorni"} · ${rule.from}:00–${rule.until}:00`;
}
