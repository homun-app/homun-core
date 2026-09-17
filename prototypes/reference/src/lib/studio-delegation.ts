import type { AssignedWork } from "../components/builder/StudioToday";
export function prepareDelegation(task: AssignedWork, approver = "user:fabio"): AssignedWork {
  const human = task.person.startsWith("user:");
  return {
    ...task,
    assisted: false,
    ...(!human
      ? {
          training: task.training
            ? { ...task.training }
            : {
                activity: "Nuova attività",
                scope: "Da definire insieme al supervisore",
                mode: "stage" as const,
              },
          approver: task.approver || approver,
        }
      : {}),
    files: [...(task.files || [])],
    materialLinks: (task.materialLinks || []).map((link) => ({ ...link })),
    materialReferences: [...(task.materialReferences || [])],
  };
}

export function delegationRequests(task: AssignedWork): AssignedWork[] {
  return (task.steps || [])
    .filter((s) => s.id === "input" && s.blocker && !s.done)
    .map((s) => ({
      id: task.id + ":request:" + s.id,
      title: s.reason || s.title,
      brief: s.reason || s.title,
      person: s.blocker!.replace(/^bot:/, ""),
      project: task.needsMaterials ? task.project : "",
      status: "todo",
      requestFor: task.id + ":" + s.id,
      ...(task.due ? { due: task.due } : {}),
      participants: [task.person],
      notes: ["Richiesta collegata a: " + task.title],
    }));
}
