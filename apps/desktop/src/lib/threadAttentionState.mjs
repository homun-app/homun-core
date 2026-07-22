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
    terminalEventIds[signal.threadId] = Math.max(
      terminalEventIds[signal.threadId] ?? 0,
      signal.terminalEventId,
    );
  }
  const terminalEventId = terminalEventIds[signal.threadId] ?? 0;
  const seenTerminalEventIds = { ...state.seenTerminalEventIds };
  if (signal.status === "completed" && signal.threadId === state.selectedThreadId) {
    seenTerminalEventIds[signal.threadId] = Math.max(
      seenTerminalEventIds[signal.threadId] ?? 0,
      terminalEventId,
    );
  }
  const unread = signal.status === "completed"
    && signal.threadId !== state.selectedThreadId
    && terminalEventId > (seenTerminalEventIds[signal.threadId] ?? 0);
  const status = unread
    ? "completed_unread"
    : ["running", "queued", "retrying", "retry_waiting", "waiting_resource"].includes(signal.status)
      ? "working"
      : ["waiting_user", "waiting_approval"].includes(signal.status)
        ? "waiting_user"
        : signal.status === "failed"
          ? "failed"
          : "idle";
  return {
    ...state,
    terminalEventIds,
    seenTerminalEventIds,
    byThread: { ...state.byThread, [signal.threadId]: status },
  };
}

export function hydrateThreadAttentionState(state, rows) {
  let next = state;
  for (const row of rows) {
    next = {
      ...next,
      seenTerminalEventIds: {
        ...next.seenTerminalEventIds,
        [row.threadId]: Math.max(
          next.seenTerminalEventIds[row.threadId] ?? 0,
          row.lastSeenTerminalEventId ?? 0,
        ),
      },
    };
    next = applyThreadSignal(next, row);
  }
  return next;
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
