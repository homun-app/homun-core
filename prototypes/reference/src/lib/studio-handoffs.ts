import type { AssignedWork } from "../components/builder/StudioToday";
export function hasDelivery(task: AssignedWork) {
  return !!task.result?.trim() || !!task.resultFiles?.length;
}
export function acceptDelivery(
  task: AssignedWork,
  stepId: string,
  response: AssignedWork,
): AssignedWork {
  if (
    response.status !== "done" ||
    !hasDelivery(response) ||
    response.requestFor !== task.id + ":" + stepId
  )
    return task;
  return {
    ...task,
    status: "todo",
    files: [...new Set([...(task.files || []), ...(response.resultFiles || [])])],
    steps:
      task.steps?.map((s) =>
        s.id === stepId ? { ...s, done: true, blocker: "", reason: "" } : s,
      ) || [],
    notes: [
      ...(task.notes || []),
      "Consegna accettata: " + response.title + (response.result ? " — " + response.result : ""),
    ],
    deliveries: [
      ...(task.deliveries || []),
      {
        taskId: response.id,
        title: response.title,
        files: response.resultFiles || [],
        acceptedAt: new Date().toISOString(),
      },
    ],
  };
}

export function reconcileDeliveries(tasks: AssignedWork[]): AssignedWork[] {
  return tasks.map((task) => {
    const changed =
      task.deliveries?.filter((d) => tasks.find((t) => t.id === d.taskId)?.status !== "done") || [];
    if (!changed.length) return task;
    const steps = (task.steps || []).map((step) => {
      const response = tasks.find(
        (t) => t.requestFor === task.id + ":" + step.id && changed.some((d) => d.taskId === t.id),
      );
      return response
        ? {
            ...step,
            done: false,
            blocker: response.person.startsWith("user:")
              ? response.person
              : "bot:" + response.person,
            reason: "La consegna è cambiata: attendi la nuova verifica.",
          }
        : step;
    });
    return { ...task, steps, status: "blocked" };
  });
}
