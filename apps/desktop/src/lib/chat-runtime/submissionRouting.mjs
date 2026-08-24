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
  const turnUiState = input.turnUiState ?? {};
  const lifecycle = {
    workInProgress: Boolean(turnUiState.workInProgress),
  };
  const composer = input.promptSubmitting
    ? { mode: "disabled", disabled: true, forceNewTurn: false }
    : composerModeFromKernel(input.composerMode) ?? composerModeFromKernel("new_turn");
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
