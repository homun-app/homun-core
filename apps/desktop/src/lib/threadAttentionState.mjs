export function createThreadAttentionState(selectedThreadId = "") {
  return {
    selectedThreadId,
    byThread: {},
    terminalEventIds: {},
    seenTerminalEventIds: {},
  };
}

export function applyThreadSignal(state, signal) {
  const terminalEventIds = { ...state.terminalEventIds };
  if (signal.terminalEventId != null) {
    terminalEventIds[signal.threadId] = signal.terminalEventId;
  }
  const unread = signal.status === "completed"
    && signal.threadId !== state.selectedThreadId
    && (signal.terminalEventId ?? 0) > (state.seenTerminalEventIds[signal.threadId] ?? 0);
  const status = unread
    ? "completed_unread"
    : ["running", "queued", "retrying"].includes(signal.status)
      ? "working"
      : signal.status === "waiting_user"
        ? "waiting_user"
        : signal.status === "failed"
          ? "failed"
          : "idle";
  return {
    ...state,
    terminalEventIds,
    byThread: { ...state.byThread, [signal.threadId]: status },
  };
}

export function selectThread(state, threadId) {
  const terminal = state.terminalEventIds[threadId] ?? 0;
  return {
    ...state,
    selectedThreadId: threadId,
    byThread: { ...state.byThread, [threadId]: "idle" },
    seenTerminalEventIds: {
      ...state.seenTerminalEventIds,
      [threadId]: terminal,
    },
  };
}
