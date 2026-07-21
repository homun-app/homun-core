export type HostComputerPhase =
  | "idle" | "observing" | "awaiting_approval" | "acting" | "paused_by_user"
  | "suspended" | "done" | "failed" | "cancelled";

export interface HostComputerApproval {
  category: string;
  summary: string;
  actionDigest: string;
}

export interface HostComputerState {
  sequence: number;
  sessionId: string | null;
  phase: HostComputerPhase;
  app: string | null;
  window: string | null;
  artifactRef: string | null;
  pendingApproval: HostComputerApproval | null;
  canResume: boolean;
  needsHydration: boolean;
  errorCode: string | null;
}

export { initialHostComputerState, reduceHostComputerEvent } from "./hostComputerState.mjs";
