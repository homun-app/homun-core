export interface ProactivityFreshnessInput {
  generated_at?: number | null;
  created_at?: number | null;
  relevant_until?: number | null;
}

export type ProactivityFreshness = "fresh" | "stale" | "expired";

export function freshness(
  card: ProactivityFreshnessInput,
  now: number,
): ProactivityFreshness;
