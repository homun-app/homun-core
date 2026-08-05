export function selectInitialThreadFromSnapshot({
  mappedThreads,
  snapshotActiveThreadId,
  defaultThread,
}) {
  const selectedThread =
    mappedThreads.find((thread) => thread.threadId === snapshotActiveThreadId) ??
    mappedThreads[0] ??
    defaultThread;

  return {
    desiredThreads: mappedThreads.length ? mappedThreads : [defaultThread],
    selectedThread,
  };
}
