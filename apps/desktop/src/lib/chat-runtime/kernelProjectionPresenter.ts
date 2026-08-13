// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./kernelProjectionPresenter.mjs";
import type { KernelThreadProjection } from "../chatApi";

export interface KernelProjectionPresenterInput {
  projectionLoaded: boolean;
  projection: KernelThreadProjection | null;
  isStreaming: boolean;
  liveActivitySteps: string[];
  livePlanMarkdown: string | null;
  streamOwnerTurnId: string | null;
}

export interface KernelProjectionPresenterView {
  conversationPlan: string | null;
  conversationActivity: string[];
  workspacePlanSteps: Array<{
    id: string;
    title: string;
    status: string;
    detail: string | null;
  }>;
  workspacePlanGoal: string | null;
  turnUiState: {
    isStreaming: boolean;
    hasActiveTurn: boolean;
    workInProgress: boolean;
    canStop: boolean;
    terminalTurnAtRest: boolean;
    turnAwaitingUser: boolean;
  };
  composerMode: string;
  attentionItems: Array<
    | {
        kind: "approval";
        id: string;
        action: string;
        riskLevel: string;
      }
    | {
        kind: "uncertain_effect";
        id: string;
        operation: string;
        effectClass: string;
      }
  >;
  browserStatus: {
    active: boolean;
    done: boolean;
    failed: boolean;
    state: string;
    snapshotVerified: boolean;
    failureReason: string | null;
    latestProgress: string | null;
  };
  capabilityRuntime: {
    loadedTools: string[];
    armedSensitiveDomains: string[];
    pendingCapability: string | null;
    blockedCapabilities: Array<{
      key: string;
      reason: string;
    }>;
  };
}

export const projectKernelThreadView: (
  input: KernelProjectionPresenterInput,
) => KernelProjectionPresenterView = implementation.projectKernelThreadView as (
  input: KernelProjectionPresenterInput,
) => KernelProjectionPresenterView;
