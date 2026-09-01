import type {
  IntegrityAuditResponse,
  RuntimeContextProvenance,
  RuntimeContextResponse,
} from "./coreBridge";

// Node contract tests and the renderer share this dependency-free implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./runtimeContext.mjs";

export interface RuntimeContributionView {
  estimatedTokens: number;
  source: RuntimeContextProvenance;
}

export interface RuntimeContextView {
  effectiveModel: string | null;
  selectedNextModel: string | null;
  provider: string | null;
  locality: string | null;
  role: string | null;
  contextWindow: number | null;
  usedTokens: number | null;
  percent: number | null;
  compacted: boolean;
  contributions: {
    conversation: RuntimeContributionView | null;
    compactedSummary: RuntimeContributionView | null;
    filesArtifacts: RuntimeContributionView | null;
    authorizedMemory: RuntimeContributionView | null;
    systemTools: RuntimeContributionView | null;
  };
}

export interface RuntimeDiagnosticGapView {
  code: string;
  owner: string;
  summary: string;
  severity: string;
}

export interface RuntimeIntegrityView {
  available: boolean;
  healthy: boolean;
  integrityOk: boolean;
  errorCount: number;
  warningCount: number;
  diagnosticGapCount: number;
  visibleDiagnosticGaps: RuntimeDiagnosticGapView[];
  hiddenDiagnosticGapCount: number;
}

export const runtimeContextView = implementation.runtimeContextView as (
  response: RuntimeContextResponse | null | undefined,
  selectedNextModel: string | null,
) => RuntimeContextView;

export const runtimeIntegrityView = implementation.runtimeIntegrityView as (
  response: IntegrityAuditResponse | null | undefined,
  maxVisibleGaps?: number,
) => RuntimeIntegrityView;
