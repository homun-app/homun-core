export function projectSelectedTask({
  taskItems,
  selectedTaskId,
  activeThread,
  fallbackTask,
}) {
  return (
    taskItems.find((task) => task.id === selectedTaskId) ?? {
      ...fallbackTask,
      id: activeThread.taskId,
      title: activeThread.title,
      kind: "prompt_session",
      status: "queued",
    }
  );
}
