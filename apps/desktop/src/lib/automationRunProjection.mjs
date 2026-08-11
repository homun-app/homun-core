export function projectAutomationRunState(task, kernelProjection = null) {
  const taskThreadId = typeof task?.thread_id === "string" ? task.thread_id : null;
  const projectionThreadId =
    typeof kernelProjection?.thread_id === "string" ? kernelProjection.thread_id : null;
  const kernelStatus =
    taskThreadId && projectionThreadId === taskThreadId
      ? kernelProjection?.turn?.status
      : null;

  const status = kernelStatus || task?.status;
  switch (status) {
    case "queued":
    case "pending":
    case "waiting_time":
      return { state: "queued", labelKey: "automations.inQueue" };
    case "completed":
    case "failed":
    case "cancelled":
    case "expired":
      return { state: "terminal", labelKey: "automations.inQueue" };
    case "idle":
      return task?.status && task.status !== "idle"
        ? projectAutomationRunState({ ...task, thread_id: null }, null)
        : { state: "queued", labelKey: "automations.inQueue" };
    case "running":
    case "waiting_user":
    case "waiting_approval":
    case "waiting_user_approval":
    case "waiting_resource":
    case "waiting_external_event":
    case "parked":
    default:
      return { state: "running", labelKey: "automations.inProgress" };
  }
}
