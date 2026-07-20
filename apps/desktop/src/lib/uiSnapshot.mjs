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
    left.project_relative_path === right.project_relative_path &&
    left.project_path === right.project_path &&
    left.managed_path === right.managed_path &&
    left.size === right.size &&
    left.updated === right.updated &&
    left.thread === right.thread;
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
