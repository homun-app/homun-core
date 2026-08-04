export type ComposerMode = "new_turn" | "steering" | "waiting_user_reply" | "disabled";

export interface ComposerModeInput {
  promptSubmitting: boolean;
  streamingAssistantId: string | null;
  turnAwaitingUser: boolean;
  terminalTurnAtRest: boolean;
  hasActiveTurn: boolean;
}

export interface ComposerModeView {
  mode: ComposerMode;
  disabled: boolean;
  forceNewTurn: boolean;
}

export function deriveComposerMode(input: ComposerModeInput): ComposerModeView {
  if (input.promptSubmitting) {
    return { mode: "disabled", disabled: true, forceNewTurn: false };
  }
  if (input.turnAwaitingUser) {
    return { mode: "waiting_user_reply", disabled: false, forceNewTurn: true };
  }
  if (input.terminalTurnAtRest || !input.hasActiveTurn) {
    return { mode: "new_turn", disabled: false, forceNewTurn: true };
  }
  if (input.streamingAssistantId || input.hasActiveTurn) {
    return { mode: "steering", disabled: false, forceNewTurn: false };
  }
  return { mode: "new_turn", disabled: false, forceNewTurn: true };
}
