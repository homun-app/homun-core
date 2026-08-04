import type { RuntimeContextProvenance, RuntimeContextResponse } from "./coreBridge";

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

export const runtimeContextView = implementation.runtimeContextView as (
  response: RuntimeContextResponse | null | undefined,
  selectedNextModel: string | null,
) => RuntimeContextView;
