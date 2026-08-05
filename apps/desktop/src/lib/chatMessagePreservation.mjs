export function hasPendingLocalMessages(messages) {
  return messages.some((message) => message.id.startsWith("local_"));
}

export function shouldPreserveLocalMessages({
  currentMessages,
  incomingMessages,
  isProtected,
}) {
  if (!currentMessages?.length) return false;
  if (!isProtected) return false;
  const incomingIds = new Set(incomingMessages.map((message) => message.id));
  return currentMessages.some(
    (message) => message.id.startsWith("local_") && !incomingIds.has(message.id),
  );
}
