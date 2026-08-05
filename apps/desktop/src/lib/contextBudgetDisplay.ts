// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./contextBudgetDisplay.mjs";

export interface ContextBudgetRatioItem {
  inputChars: number;
  outputChars: number;
}

export interface ContextBudgetSummaryItem {
  compressed: boolean;
  redacted: boolean;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  redactionCount: number;
}

export const contextBudgetCompressionRatio =
  implementation.contextBudgetCompressionRatio as (
    budget: ContextBudgetRatioItem[],
  ) => number;

export const contextBudgetSummary = implementation.contextBudgetSummary as (
  budget: ContextBudgetSummaryItem[],
) => string;
