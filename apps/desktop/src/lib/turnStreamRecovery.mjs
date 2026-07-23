import { applyTurnEvent, createTurnReplayState } from "./turnReplayState.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_DELAYS = [100, 250, 500, 1000, 2000];

export class TurnStreamRecoveryError extends Error {
  constructor(message, code = "turn_stream_recovery_exhausted", cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TurnStreamRecoveryError";
    this.code = code;
  }
}

export async function recoverTurnStream(options) {
  const {
    turnId,
    connect,
    getStatus,
    onEvent = () => {},
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    maxReconnects = DEFAULT_DELAYS.length,
    reconnectDelays = DEFAULT_DELAYS,
    initialState,
  } = options;
  let state = initialState ?? createTurnReplayState(turnId);
  let reconnects = 0;
  let lastTransportError;

  while (true) {
    try {
      await connect({
        turnId,
        since: state.lastSeq,
        onEvent: (event) => {
          const next = applyTurnEvent(state, event);
          if (next === state) return;
          state = next;
          onEvent(event, state);
        },
      });
      lastTransportError = undefined;
    } catch (error) {
      lastTransportError = error;
    }

    if (TERMINAL.has(state.status)) return state;

    try {
      await getStatus(turnId);
    } catch (error) {
      throw new TurnStreamRecoveryError(
        `Turn ${turnId} cannot be recovered because its durable state is unavailable.`,
        "turn_stream_state_unavailable",
        error,
      );
    }

    if (reconnects >= maxReconnects) {
      throw new TurnStreamRecoveryError(
        `Turn ${turnId} stream ended without a durable terminal after ${reconnects} reconnects.`,
        "turn_stream_recovery_exhausted",
        lastTransportError,
      );
    }

    const delay = reconnectDelays[Math.min(reconnects, reconnectDelays.length - 1)] ?? 0;
    reconnects += 1;
    await sleep(delay);
  }
}
