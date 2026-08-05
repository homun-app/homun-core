export function attentionRequiredThreadIds(threads, approvals, uncertainEffects) {
  const ids = new Set();
  for (const effect of uncertainEffects) {
    if (effect.threadId) ids.add(effect.threadId);
  }
  for (const approval of approvals) {
    const owner = threads.find(
      (thread) =>
        thread.taskId === approval.taskId ||
        (approval.requestedBy && approval.requestedBy.includes(thread.computerSessionId)),
    );
    if (owner) ids.add(owner.threadId);
  }
  return ids;
}

export function mergeConversationAttention(base, attentionRequired) {
  const merged = { ...base };
  for (const threadId of attentionRequired) merged[threadId] = "waiting_user";
  return merged;
}

export function projectConversationAttention(base, busyThreadIds, attentionRequired) {
  const attention = { ...base };
  for (const threadId of busyThreadIds) {
    if (!attention[threadId] || attention[threadId] === "idle") {
      attention[threadId] = "working";
    }
  }
  return mergeConversationAttention(attention, attentionRequired);
}

export function requiresAttention(status) {
  return status === "waiting_user" || status === "failed";
}
