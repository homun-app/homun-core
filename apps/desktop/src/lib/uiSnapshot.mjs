function sameJson(left, right) {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameChatMessage(left, right) {
  return left.id === right.id &&
    left.role === right.role &&
    left.text === right.text &&
    left.timestamp === right.timestamp &&
    left.metadata === right.metadata &&
    left.model === right.model &&
    left.feedback === right.feedback &&
    left.savedMemoryRef === right.savedMemoryRef &&
    left.linkedTaskId === right.linkedTaskId &&
    left.linkedAutomationRef === right.linkedAutomationRef &&
    sameJson(left.metrics, right.metrics) &&
    sameJson(left.attachments, right.attachments) &&
    sameJson(left.eventParts, right.eventParts);
}

function sameMemoryArtifact(left, right) {
  return left.reference === right.reference &&
    left.name === right.name &&
    left.title === right.title &&
    left.artifact_type === right.artifact_type &&
    left.source === right.source &&
    left.storage === right.storage &&
    left.project_relative_path === right.project_relative_path &&
    left.project_path === right.project_path &&
    left.managed_path === right.managed_path &&
    left.size === right.size &&
    left.updated === right.updated &&
    left.thread === right.thread;
}

function sameChatThread(left, right) {
  return left.threadId === right.threadId &&
    left.workspaceId === right.workspaceId &&
    left.title === right.title &&
    left.subtitle === right.subtitle &&
    left.status === right.status &&
    left.pinned === right.pinned &&
    left.computerSessionId === right.computerSessionId &&
    left.taskId === right.taskId &&
    left.updatedAt === right.updatedAt &&
    left.messageCount === right.messageCount &&
    left.source === right.source &&
    left.channelRecipient === right.channelRecipient;
}

/// Identity-preserving reconciliation for the thread list, mirroring what
/// `reconcileChatMessages` already does for messages. The operational poll runs
/// every 2.5s: without this, each tick handed React a brand-new array of
/// brand-new objects, so the `activeThread` memo changed and App/Sidebar/Shell/
/// ChatView re-rendered even mid-stream — a periodic hitch on top of the rAF loop.
/// Order is compared positionally (the sidebar is most-recent-first, so a
/// reorder with no field change is a real change and must reach the UI), while
/// the by-id fallback still lets a moved row keep its object identity.
export function reconcileChatThreads(current, incoming) {
  if (!current || current.length !== incoming.length) return incoming;
  let changed = false;
  let byId = null;
  const merged = incoming.map((thread, index) => {
    if (sameChatThread(current[index], thread)) return current[index];
    changed = true;
    if (!byId) byId = new Map(current.map((item) => [item.threadId, item]));
    const moved = byId.get(thread.threadId);
    return moved && sameChatThread(moved, thread) ? moved : thread;
  });
  return changed ? merged : current;
}

export function reconcileChatMessages(current, incoming) {
  if (!current || current.length !== incoming.length) return incoming;
  return current.every((item, index) => sameChatMessage(item, incoming[index]))
    ? current
    : incoming;
}

export function reconcileMemoryArtifacts(current, incoming) {
  if (current.length !== incoming.length) return incoming;
  return current.every((item, index) => sameMemoryArtifact(item, incoming[index]))
    ? current
    : incoming;
}
