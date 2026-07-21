const DAY_SECONDS = 86_400;

export function totalTokens(point = {}) {
  return [
    point.input_tokens,
    point.output_tokens,
    point.reasoning_tokens,
    point.cache_read_tokens,
    point.cache_write_tokens,
  ].reduce((sum, value) => sum + finiteNonnegative(value), 0);
}

export function totalKnownCost(point = {}) {
  const cost = point.cost_breakdown ?? {};
  return finiteNonnegative(cost.provider_reported_microusd)
    + finiteNonnegative(cost.catalog_estimated_microusd)
    + finiteNonnegative(cost.manual_estimated_microusd);
}

export function routeLabel(point = {}, unknownLabel = "Unknown route") {
  const provider = cleanLabel(point.dominant_provider);
  const model = cleanLabel(point.dominant_model);
  if (provider && model) return `${provider} → ${model}`;
  if (provider) return `${provider} → ${unknownLabel}`;
  if (model) return `${unknownLabel} → ${model}`;
  return unknownLabel;
}

export function usageIntensityLevels(values) {
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

export function buildCalendarDays(series, window, nowMs = Date.now()) {
  const offsetSeconds = clampOffset(series?.timezone_offset_minutes) * 60;
  const todayEpoch = localDayEpoch(Math.floor(nowMs / 1_000), offsetSeconds);
  const coverageEpoch = series?.coverage_started_at == null
    ? null
    : localDayEpoch(series.coverage_started_at, offsetSeconds);
  const startEpoch = window === "7d"
    ? todayEpoch - 6 * DAY_SECONDS
    : window === "30d"
      ? todayEpoch - 29 * DAY_SECONDS
      : coverageEpoch ?? todayEpoch;
  const points = new Map((series?.days ?? []).map((point) => [point.day_epoch, point]));
  const days = [];
  for (let dayEpoch = startEpoch; dayEpoch <= todayEpoch; dayEpoch += DAY_SECONDS) {
    const point = points.get(dayEpoch) ?? emptyPoint(dayEpoch);
    const covered = coverageEpoch != null && dayEpoch >= coverageEpoch;
    const active = covered && (finiteNonnegative(point.attempts) > 0 || totalTokens(point) > 0);
    days.push({
      ...point,
      day_epoch: dayEpoch,
      state: !covered ? "unavailable" : active ? "active" : "zero",
      intensity: 0,
    });
  }
  const activeDays = days.filter((day) => day.state === "active");
  const levels = usageIntensityLevels(activeDays.map((day) => totalTokens(day) || 1));
  activeDays.forEach((day, index) => { day.intensity = levels[index] || 1; });
  return days;
}

function emptyPoint(dayEpoch) {
  return {
    day_epoch: dayEpoch,
    logical_calls: 0,
    attempts: 0,
    successful_attempts: 0,
    failed_attempts: 0,
    aborted_attempts: 0,
    known_usage_attempts: 0,
    unknown_usage_attempts: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_breakdown: {
      provider_reported_microusd: 0,
      catalog_estimated_microusd: 0,
      manual_estimated_microusd: 0,
      not_billed_attempts: 0,
      unknown_cost_attempts: 0,
      cost_coverage_percent: 0,
    },
    dominant_provider: null,
    dominant_model: null,
  };
}

function finiteNonnegative(value) {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function cleanLabel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function clampOffset(value) {
  return Math.max(-840, Math.min(840, Number.isFinite(value) ? Math.trunc(value) : 0));
}

function localDayEpoch(epoch, offsetSeconds) {
  return Math.floor((epoch + offsetSeconds) / DAY_SECONDS) * DAY_SECONDS;
}
