import type { AssignedWork } from "../components/builder/StudioToday";
import { hasDelivery } from "./studio-handoffs.ts";
export function moveIssue(task: AssignedWork, status: NonNullable<AssignedWork["status"]>): string {
  if (
    task.training?.mode === "stage" &&
    status !== "todo" &&
    status !== "blocked" &&
    !task.steps?.some((s) => s.id !== "input" && s.id !== "pipeline-gate")
  )
    return "Entra nei dettagli e concorda il metodo: in stage servono passaggi da verificare.";
  if (task.steps?.some((s) => s.blocker && !s.done))
    return "Questo compito aspetta una consegna. Aprilo per gestire l’attesa.";
  if (status === "blocked") return "Indica nei dettagli cosa manca o chi deve intervenire.";
  if (status === "review" || status === "done") {
    if (task.steps?.some((s) => !s.done))
      return "Ci sono passaggi da verificare. Apri il compito prima di concluderlo.";
    if (!hasDelivery(task) && !task.person.startsWith("user:"))
      return "L’agente deve presentare un risultato prima della verifica.";
  }
  if (
    status === "done" &&
    (task.rule?.approval !== false || (task.training && task.training.mode !== "autonomous")) &&
    (task.rule || !task.person.startsWith("user:")) &&
    task.status !== "review" &&
    task.status !== "done"
  )
    return "Il risultato richiede prima una revisione: spostalo in Da approvare.";
  if (status === "done" && task.approver && task.approver !== "user:fabio")
    return "L’approvazione è assegnata a un’altra persona.";
  return "";
}
export function moveWork(
  tasks: AssignedWork[],
  id: string,
  status: NonNullable<AssignedWork["status"]>,
  before?: string,
): AssignedWork[] {
  const task = tasks.find((t) => t.id === id);
  if (!task || moveIssue(task, status)) return tasks;
  const moved = {
    ...task,
    status,
    notes: [...(task.notes || []), `Fabio · stato aggiornato dalla bacheca: ${status}`],
  };
  const next = tasks.filter((t) => t.id !== id);
  const index = before ? next.findIndex((t) => t.id === before) : -1;
  next.splice(index < 0 ? next.length : index, 0, moved);
  return next;
}
