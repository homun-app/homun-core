export function projectThreadSnapshotSelection({
  mappedThreads,
  activeThreadId,
  snapshotActiveThreadId,
  defaultThread,
}) {
  const preservedThread = mappedThreads.find(
    (thread) => thread.threadId === activeThreadId && thread.status === "active",
  );
  const selectedThread =
    preservedThread ??
    mappedThreads.find(
      (thread) =>
        thread.threadId === snapshotActiveThreadId && thread.status === "active",
    ) ??
    mappedThreads.find((thread) => thread.status === "active") ??
    defaultThread;

  return {
    desiredThreads: mappedThreads.length ? mappedThreads : [defaultThread],
    preservedThread,
    selectedThread,
  };
}
