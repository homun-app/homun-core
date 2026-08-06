import { deriveComposerMode } from "./composerMode.mjs";
import { deriveTurnLifecycle } from "./lifecycle.mjs";

// ChatView composer submission route: the composed lifecycle + composer-mode
// decision that selects steering for the active turn versus starting a new turn.
export function routeComposerSubmission(input) {
  const lifecycle = deriveTurnLifecycle({
    promptSubmitting: Boolean(input.promptSubmitting),
    streamingAssistantId: input.streamingAssistantId ?? null,
    projectedActiveTurn: input.projectedActiveTurn ?? null,
    projectedTurnStatus: input.projectedTurnStatus ?? null,
    projectionLoaded: Boolean(input.projectionLoaded),
    threadTailAwaitsHitl: Boolean(input.threadTailAwaitsHitl),
  });
  const composer = deriveComposerMode({
    promptSubmitting: Boolean(input.promptSubmitting),
    streamingAssistantId: input.streamingAssistantId ?? null,
    turnAwaitingUser: lifecycle.turnAwaitingUser,
    terminalTurnAtRest: lifecycle.terminalTurnAtRest,
    hasActiveTurn: lifecycle.hasActiveTurn,
  });
  const forceNewTurn = Boolean(input.explicitForceNewTurn || composer.forceNewTurn);
  const routesToSteering = Boolean(lifecycle.workInProgress && !forceNewTurn);

  return {
    mode: composer.mode,
    disabled: composer.disabled,
    workInProgress: lifecycle.workInProgress,
    forceNewTurn,
    routesToSteering,
  };
}
