import * as implementation from "./proactivityFreshness.mjs";

export interface ProactivityFreshnessInput {
  generated_at?: number | null;
  created_at?: number | null;
  relevant_until?: number | null;
}

export type ProactivityFreshness = "fresh" | "stale" | "expired";

export const freshness: (
  card: ProactivityFreshnessInput,
  now: number,
) => ProactivityFreshness = implementation.freshness;
