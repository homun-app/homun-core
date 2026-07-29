const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function createTurnReplayState(turnId, snapshot = {}) {
  return {
    turnId,
    lastSeq: Math.max(0, Number(snapshot.lastSeq) || 0),
    status: snapshot.status ?? "running",
    text: snapshot.text ?? "",
  };
}

export function applyTurnEvent(state, event) {
  const seq = Number(event?.seq) || 0;
  if (
    event?.turn_id !== state.turnId
    || seq <= state.lastSeq
    || TERMINAL.has(state.status)
  ) {
    return state;
  }

  const next = { ...state, lastSeq: seq };
  switch (event.kind) {
    case "delta":
      next.text += event.payload?.text ?? "";
      next.status = "running";
      break;
    case "done":
      if (typeof event.payload?.text === "string") {
        next.text = event.payload.text;
      }
      next.status = "completed";
      break;
    case "suspended":
      next.status = "completed";
      break;
    case "error":
      next.status = "failed";
      break;
    case "cancelled":
      next.status = "cancelled";
      break;
    case "retry":
      next.status = "retrying";
      break;
    case "aborted":
      next.status = "retrying";
      next.text = "";
      break;
    default:
      break;
  }
  return next;
}

export function prepareHitlResumeMessages(messages, assistantMessageId, userMessage) {
  const assistant = messages.find((message) => message.id === assistantMessageId);
  if (!assistant) return null;
  return {
    promptMessages: [
      ...messages.filter((message) => message.id !== assistantMessageId),
      userMessage,
    ],
    streamingMessage: {
      ...assistant,
      text: "",
      timestamp: userMessage.timestamp ?? assistant.timestamp,
      eventParts: [],
    },
  };
}
