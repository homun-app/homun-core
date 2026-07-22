export type SetupComputerPhase =
  | "idle"
  | "checking_docker"
  | "preparing_image"
  | "starting_container"
  | "verifying_browser"
  | "ready"
  | "failed";

export interface SetupComputerStatus {
  phase: SetupComputerPhase;
  ready: boolean;
  error: string | null;
}

export type ComputerProgressRowId = "docker" | "image" | "container" | "browser";
export type ComputerProgressRowState = "pending" | "active" | "done" | "error";

export interface ComputerProgressRow {
  id: ComputerProgressRowId;
  state: ComputerProgressRowState;
}

const ROW_IDS: readonly ComputerProgressRowId[] = [
  "docker",
  "image",
  "container",
  "browser",
];

const ACTIVE_ROW_BY_PHASE: Partial<Record<SetupComputerPhase, number>> = {
  checking_docker: 0,
  preparing_image: 1,
  starting_container: 2,
  verifying_browser: 3,
};

export function computerProgressRows(phase: SetupComputerPhase): ComputerProgressRow[] {
  if (phase === "ready") {
    return ROW_IDS.map((id) => ({ id, state: "done" }));
  }
  if (phase === "failed") {
    return ROW_IDS.map((id, index) => ({
      id,
      state: index === 0 ? "error" : "pending",
    }));
  }
  const activeIndex = ACTIVE_ROW_BY_PHASE[phase];
  return ROW_IDS.map((id, index) => ({
    id,
    state:
      activeIndex == null
        ? "pending"
        : index < activeIndex
          ? "done"
          : index === activeIndex
            ? "active"
            : "pending",
  }));
}

export function canContinueFromComputer(status: SetupComputerStatus): boolean {
  return status.phase === "ready" && status.ready === true;
}
