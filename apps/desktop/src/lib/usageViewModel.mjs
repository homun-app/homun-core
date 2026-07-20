const clampNumber = (value) =>
  Number.isFinite(value) && value > 0 ? value : 0;

const clampPercent = (value) =>
  Math.min(100, Math.max(0, Math.round(clampNumber(value))));

export function formatMicrousd(value, locale = "en-US") {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(clampNumber(value) / 1_000_000);
}

export function formatCount(value, locale = "en-US") {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 })
    .format(clampNumber(value));
}

export function costLabel(value, locale = "en-US") {
  return {
    reported: `${formatMicrousd(value.reported, locale)} reported`,
    estimated: `${formatMicrousd(value.estimated, locale)} estimated`,
    unknown: `${Math.round(clampNumber(value.unknown))} attempts unknown`,
  };
}

export function coverageState(usageCoverage, costCoverage) {
  const usage = clampPercent(usageCoverage);
  const cost = clampPercent(costCoverage);
  return {
    tone: usage === 100 && cost === 100 ? "good" : "warning",
    label: `${usage}% usage · ${cost}% cost`,
  };
}

export function providerLimitLabel({ source, remainingPercent }) {
  const remaining = clampPercent(remainingPercent);
  if (source === "manual_budget") {
    return `${remaining}% of manual budget remaining`;
  }
  if (source === "provider_account") {
    return `${remaining}% of provider limit remaining`;
  }
  return "No limit available";
}

export function providerSnapshotState(snapshot, nowEpochSeconds = Date.now() / 1000) {
  const status = snapshot?.status ?? "unsupported";
  if (status === "unauthorized") return { tone: "warning", label: "Unauthorized", stale: false };
  if (status === "error") return { tone: "warning", label: "Provider error", stale: false };
  if (status !== "available") return { tone: "neutral", label: "Unsupported", stale: false };
  const observedAt = clampNumber(snapshot?.observed_at);
  const stale = observedAt > 0 && clampNumber(nowEpochSeconds) - observedAt > 86_400;
  return {
    tone: stale ? "warning" : "good",
    label: stale ? "Stale provider data" : "Available",
    stale,
  };
}

export function remainingBudgetPercent(budgetMicrousd, spentMicrousd, costCoveragePercent) {
  const budget = clampNumber(budgetMicrousd);
  if (budget === 0 || clampPercent(costCoveragePercent) < 100) return null;
  const remaining = Math.max(0, budget - clampNumber(spentMicrousd));
  return clampPercent((remaining / budget) * 100);
}

export { clampNumber, clampPercent };
