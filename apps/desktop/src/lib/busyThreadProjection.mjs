export function projectBusyThreadIds({
  backgroundStreamIds,
  streamingThreadId,
  chatThreads,
  taskItems,
}) {
  const ids = new Set(backgroundStreamIds);
  if (streamingThreadId) ids.add(streamingThreadId);

  const tasksById = new Map(taskItems.map((task) => [task.id, task]));
  for (const thread of chatThreads) {
    const task = tasksById.get(thread.taskId);
    if (task && (task.status === "running" || task.status === "queued")) {
      ids.add(thread.threadId);
    }
  }
  return ids;
}
