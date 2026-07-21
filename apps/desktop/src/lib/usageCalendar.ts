export type UsageWindowLike = "7d" | "30d" | "all";

export interface UsageCostLike {
  provider_reported_microusd?: number;
  catalog_estimated_microusd?: number;
  manual_estimated_microusd?: number;
  not_billed_attempts?: number;
  unknown_cost_attempts?: number;
  cost_coverage_percent?: number;
}

export interface UsageDailyPointLike {
  day_epoch: number;
  logical_calls?: number;
  attempts?: number;
  successful_attempts?: number;
  failed_attempts?: number;
  aborted_attempts?: number;
  known_usage_attempts?: number;
  unknown_usage_attempts?: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_breakdown?: UsageCostLike;
  dominant_provider?: string | null;
  dominant_model?: string | null;
}

export interface UsageDailySeriesLike {
  coverage_started_at?: number | null;
  timezone_offset_minutes?: number;
  days?: UsageDailyPointLike[];
}

export type CalendarDay = Required<Omit<UsageDailyPointLike, "dominant_provider" | "dominant_model">>
  & Pick<UsageDailyPointLike, "dominant_provider" | "dominant_model">
  & { state: "unavailable" | "zero" | "active"; intensity: number };

const DAY_SECONDS = 86_400;

export function totalTokens(point: UsageDailyPointLike = { day_epoch: 0 }): number {
  return [point.input_tokens, point.output_tokens, point.reasoning_tokens, point.cache_read_tokens, point.cache_write_tokens]
    .reduce<number>((sum, value) => sum + finiteNonnegative(value), 0);
}

export function totalKnownCost(point: UsageDailyPointLike = { day_epoch: 0 }): number {
  const cost = point.cost_breakdown ?? {};
  return finiteNonnegative(cost.provider_reported_microusd)
    + finiteNonnegative(cost.catalog_estimated_microusd)
    + finiteNonnegative(cost.manual_estimated_microusd);
}

export function routeLabel(
  point: Pick<UsageDailyPointLike, "dominant_provider" | "dominant_model"> = {},
  unknownLabel = "Unknown route",
): string {
  const provider = cleanLabel(point.dominant_provider);
  const model = cleanLabel(point.dominant_model);
  if (provider && model) return `${provider} → ${model}`;
  if (provider) return `${provider} → ${unknownLabel}`;
  if (model) return `${unknownLabel} → ${model}`;
  return unknownLabel;
}

export function resolvedProviderLabel(
  providerId: string | null | undefined,
  labels: Record<string, string>,
): string | null {
  const id = cleanLabel(providerId);
  if (!id) return null;
  return cleanLabel(labels[id]) || id;
}

export function usageIntensityLevels(values: number[]): number[] {
  const positive = values.map(finiteNonnegative).filter((value) => value > 0);
  const unique = [...new Set(positive)].sort((a, b) => a - b);
  if (!unique.length) return values.map(() => 0);
  return values.map((raw) => {
    const value = finiteNonnegative(raw);
    if (value <= 0) return 0;
    if (unique.length === 1) return 2;
    const rank = unique.indexOf(value);
    return Math.min(4, Math.max(1, Math.round((rank / (unique.length - 1)) * 3) + 1));
  });
}

export function buildCalendarDays(series: UsageDailySeriesLike, window: UsageWindowLike, nowMs = Date.now()): CalendarDay[] {
  const offsetSeconds = clampOffset(series.timezone_offset_minutes) * 60;
  const todayEpoch = localDayEpoch(Math.floor(nowMs / 1_000), offsetSeconds);
  const coverageEpoch = series.coverage_started_at == null ? null : localDayEpoch(series.coverage_started_at, offsetSeconds);
  const startEpoch = window === "7d" ? todayEpoch - 6 * DAY_SECONDS
    : window === "30d" ? todayEpoch - 29 * DAY_SECONDS : coverageEpoch ?? todayEpoch;
  const points = new Map((series.days ?? []).map((point) => [point.day_epoch, point]));
  const days: CalendarDay[] = [];
  for (let dayEpoch = startEpoch; dayEpoch <= todayEpoch; dayEpoch += DAY_SECONDS) {
    const point = points.get(dayEpoch) ?? emptyPoint(dayEpoch);
    const covered = coverageEpoch != null && dayEpoch >= coverageEpoch;
    const active = covered && (finiteNonnegative(point.attempts) > 0 || totalTokens(point) > 0);
    days.push({ ...emptyPoint(dayEpoch), ...point, day_epoch: dayEpoch, state: !covered ? "unavailable" : active ? "active" : "zero", intensity: 0 });
  }
  const activeDays = days.filter((day) => day.state === "active");
  const levels = usageIntensityLevels(activeDays.map((day) => totalTokens(day) || 1));
  activeDays.forEach((day, index) => { day.intensity = levels[index] || 1; });
  return days;
}

function emptyPoint(dayEpoch: number): CalendarDay {
  return {
    day_epoch: dayEpoch, logical_calls: 0, attempts: 0, successful_attempts: 0,
    failed_attempts: 0, aborted_attempts: 0, known_usage_attempts: 0,
    unknown_usage_attempts: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0,
    cost_breakdown: { provider_reported_microusd: 0, catalog_estimated_microusd: 0, manual_estimated_microusd: 0, not_billed_attempts: 0, unknown_cost_attempts: 0, cost_coverage_percent: 0 },
    dominant_provider: null, dominant_model: null, state: "zero", intensity: 0,
  };
}

function finiteNonnegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function cleanLabel(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function clampOffset(value: unknown): number {
  return Math.max(-840, Math.min(840, typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0));
}

function localDayEpoch(epoch: number, offsetSeconds: number): number {
  return Math.floor((epoch + offsetSeconds) / DAY_SECONDS) * DAY_SECONDS;
}
