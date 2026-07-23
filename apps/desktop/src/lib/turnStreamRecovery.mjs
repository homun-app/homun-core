import { applyTurnEvent, createTurnReplayState } from "./turnReplayState.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const DURABLE_TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);
const DURABLE_HANDOFF = new Set(["waiting_user_approval"]);
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
    maxActiveReconnects = 900,
    reconnectDelays = DEFAULT_DELAYS,
    initialState,
  } = options;
  let state = initialState ?? createTurnReplayState(turnId);
  let reconnects = 0;
  let activeReconnects = 0;
  let terminalRecoveryAttempts = 0;
  let lastTransportError;

  while (true) {
    const seqBeforeConnection = state.lastSeq;
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

    let durableStatus;
    try {
      durableStatus = await getStatus(turnId);
    } catch (error) {
      throw new TurnStreamRecoveryError(
        `Turn ${turnId} cannot be recovered because its durable state is unavailable.`,
        "turn_stream_state_unavailable",
        error,
      );
    }

    if (DURABLE_HANDOFF.has(durableStatus.status) && state.lastSeq > 0) {
      return { ...state, status: "completed" };
    }

    if (DURABLE_TERMINAL.has(durableStatus.status)) {
      if (terminalRecoveryAttempts >= maxReconnects) {
        throw new TurnStreamRecoveryError(
          `Turn ${turnId} reached ${durableStatus.status} without a matching terminal stream event after ${terminalRecoveryAttempts} reconnects.`,
          "turn_stream_recovery_exhausted",
          lastTransportError,
        );
      }
      terminalRecoveryAttempts += 1;
    } else {
      // A queued/running turn can legitimately have no broadcaster yet (or can
      // be waiting behind another browser task). Empty EOFs in that state are
      // polling, not terminal-recovery failures, so they must not exhaust the
      // small budget reserved for a genuinely missing terminal event.
      terminalRecoveryAttempts = 0;
      if (state.lastSeq > seqBeforeConnection) {
        activeReconnects = 0;
      } else if (activeReconnects >= maxActiveReconnects) {
        throw new TurnStreamRecoveryError(
          `Turn ${turnId} made no stream progress while still ${durableStatus.status} after ${activeReconnects} reconnects.`,
          "turn_stream_recovery_exhausted",
          lastTransportError,
        );
      } else {
        activeReconnects += 1;
      }
    }

    const delay = reconnectDelays[Math.min(reconnects, reconnectDelays.length - 1)] ?? 0;
    reconnects += 1;
    await sleep(delay);
  }
}
