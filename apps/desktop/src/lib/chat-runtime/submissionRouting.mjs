import { deriveComposerMode } from "./composerMode.mjs";
import { deriveTurnLifecycle } from "./lifecycle.mjs";

function composerModeFromKernel(mode) {
  switch (mode) {
    case "steer_active_turn":
      return { mode: "steering", disabled: false, forceNewTurn: false };
    case "reply_to_user_wait":
    case "approval_only":
      return { mode: "waiting_user_reply", disabled: false, forceNewTurn: true };
    case "new_turn":
      return { mode: "new_turn", disabled: false, forceNewTurn: true };
    default:
      return null;
  }
}

// ChatView composer submission route: the composed lifecycle + composer-mode
// decision that selects steering for the active turn versus starting a new turn.
export function routeComposerSubmission(input) {
  const lifecycle = deriveTurnLifecycle({
    promptSubmitting: Boolean(input.promptSubmitting),
    streamingAssistantId: input.streamingAssistantId ?? null,
    projectedActiveTurn: input.projectedActiveTurn ?? null,
    projectedTurnStatus: input.projectedTurnStatus ?? null,
    projectionLoaded: Boolean(input.projectionLoaded),
  });
  const kernelComposer = input.projectionLoaded
    ? composerModeFromKernel(input.composerMode)
    : null;
  const composer = input.promptSubmitting
    ? { mode: "disabled", disabled: true, forceNewTurn: false }
    : kernelComposer ?? deriveComposerMode({
        promptSubmitting: false,
        streamingAssistantId: input.streamingAssistantId ?? null,
        turnAwaitingUser: lifecycle.turnAwaitingUser,
        terminalTurnAtRest: lifecycle.terminalTurnAtRest,
        hasActiveTurn: lifecycle.hasActiveTurn,
      });
  const forceNewTurn = Boolean(input.explicitForceNewTurn || composer.forceNewTurn);
  const routesToSteering = Boolean(lifecycle.workInProgress && !forceNewTurn && composer.mode === "steering");

  return {
    mode: composer.mode,
    disabled: composer.disabled,
    workInProgress: lifecycle.workInProgress,
    forceNewTurn,
    routesToSteering,
  };
}
