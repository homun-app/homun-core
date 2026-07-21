import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  coreBridge,
  type ApplyInstruction,
  type ModelUsageSuggestion,
  type UsageDailySeries,
  type UsageSummaryView,
  type UsageWindow,
} from "../lib/coreBridge";
import { resolvedProviderLabel, routeLabel } from "../lib/usageCalendar";
import { compactUsageRows, formatCount, formatMicrousd } from "../lib/usageViewModel";
import { UsageCalendar } from "./UsageCalendar";
import { UsageSuggestion } from "./UsageSuggestion";

const WINDOWS: UsageWindow[] = ["7d", "30d", "all"];

export function ChatUsageOverview({
  threadId,
  onOpenUsageSettings,
  onUseForTask,
}: {
  threadId: string;
  onOpenUsageSettings: () => void;
  onUseForTask: (providerId: string, modelId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [window, setWindow] = useState<UsageWindow>("30d");
  const [summary, setSummary] = useState<UsageSummaryView | null>(null);
  const [daily, setDaily] = useState<UsageDailySeries | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [summaryError, setSummaryError] = useState(false);
  const [calendarError, setCalendarError] = useState(false);
  const [suggestions, setSuggestions] = useState<ModelUsageSuggestion[]>([]);
  const [providerLabels, setProviderLabels] = useState<Record<string, string>>({});
  const summaryGenerationRef = useRef(0);
  const calendarGenerationRef = useRef(0);
  const suggestionGenerationRef = useRef(0);

  const loadSummary = useCallback(async (selectedWindow: UsageWindow) => {
    const generation = ++summaryGenerationRef.current;
    setSummaryLoading(true);
    setSummaryError(false);
    try {
      const nextSummary = await coreBridge.usageSummary(selectedWindow);
      if (summaryGenerationRef.current === generation) setSummary(nextSummary);
    } catch {
      if (summaryGenerationRef.current === generation) setSummaryError(true);
    } finally {
      if (summaryGenerationRef.current === generation) setSummaryLoading(false);
    }
  }, []);

  const loadCalendar = useCallback(async () => {
    const generation = ++calendarGenerationRef.current;
    setCalendarLoading(true);
    setCalendarError(false);
    try {
      const timezoneOffsetMinutes = -new Date().getTimezoneOffset();
      const [nextDaily, providers] = await Promise.all([
        coreBridge.usageDaily("all", timezoneOffsetMinutes),
        coreBridge.providers().catch(() => null),
      ]);
      if (calendarGenerationRef.current === generation) {
        setDaily(nextDaily);
        if (providers) {
          setProviderLabels(Object.fromEntries(providers.providers.map((provider) => [provider.id, provider.label])));
        }
      }
    } catch {
      if (calendarGenerationRef.current === generation) setCalendarError(true);
    } finally {
      if (calendarGenerationRef.current === generation) setCalendarLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSummary(window);
    return () => { summaryGenerationRef.current += 1; };
  }, [loadSummary, window]);

  useEffect(() => {
    void loadCalendar();
    return () => { calendarGenerationRef.current += 1; };
  }, [loadCalendar]);

  useEffect(() => {
    const generation = ++suggestionGenerationRef.current;
    void coreBridge.usageSuggestions(window, "home")
      .then((items) => {
        if (suggestionGenerationRef.current === generation) setSuggestions(items.slice(0, 1));
      })
      .catch(() => {
        if (suggestionGenerationRef.current === generation) setSuggestions([]);
      });
    return () => { suggestionGenerationRef.current += 1; };
  }, [window]);

  function handleInstruction(instruction: ApplyInstruction) {
    if (instruction.kind === "use_for_task") {
      onUseForTask(instruction.provider_id, instruction.model_id);
    }
  }

  const rows = summary ? compactUsageRows(summary, i18n.resolvedLanguage) : null;
  const totalTokens = summary
    ? summary.input_tokens + summary.output_tokens + summary.reasoning_tokens
      + summary.cache_read_tokens + summary.cache_write_tokens
    : 0;
  const costCoverage = summary?.cost_breakdown.cost_coverage_percent ?? 0;
  const usageCoverage = summary?.usage_coverage_percent ?? 0;
  const coverage = Math.min(costCoverage, usageCoverage);
  const dominantRoute = summary
    ? routeLabel({
        dominant_provider: resolvedProviderLabel(summary.dominant_provider, providerLabels),
        dominant_model: summary.dominant_model,
      }, t("settings.usage.calendar.unknownRoute"))
    : "—";

  return (
    <section className="chat-usage-overview" aria-label={t("chat.usageOverview.title")}>
      <header className="chat-usage-header">
        <div className="chat-usage-window" aria-label={t("chat.usageOverview.period")}>
          {WINDOWS.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={window === item}
              onClick={() => setWindow(item)}
            >
              {t(`chat.usageOverview.windows.${item}`)}
            </button>
          ))}
        </div>
        <button className="chat-usage-open" type="button" onClick={onOpenUsageSettings}>
          {t("chat.usageOverview.openSettings")}
        </button>
      </header>

      <div className="chat-usage-status" aria-live="polite">
        {((summaryLoading && !summary) || (calendarLoading && !daily)) && t("chat.usageOverview.loading")}
        {(summaryError || calendarError) && (
          <span>
            {t("chat.usageOverview.error")}{" "}
            <button
              type="button"
              onClick={() => {
                if (summaryError) void loadSummary(window);
                if (calendarError) void loadCalendar();
              }}
            >
              {t("chat.usageOverview.retry")}
            </button>
          </span>
        )}
      </div>

      {daily && (
        <div className="chat-usage-infographic">
          <UsageCalendar
            series={daily}
            window="home-26w"
            locale={i18n.resolvedLanguage}
            density="compact"
            providerLabels={providerLabels}
          />
          <div className="chat-usage-summary">
            {rows?.kind === "empty" && <p className="chat-usage-empty">{t("chat.usageOverview.empty")}</p>}
            {rows?.kind === "ready" && summary && (
              <>
                <UsageMetric label={t("settings.usage.metrics.calls")} value={formatCount(summary.logical_calls, i18n.resolvedLanguage)} />
                <UsageMetric label={t("chat.usageOverview.tokens")} value={formatCount(totalTokens, i18n.resolvedLanguage)} />
                <UsageMetric label={t("chat.usageOverview.cost")} value={formatMicrousd(summary.cost_microusd, i18n.resolvedLanguage)} />
                <UsageMetric label={t("chat.usageOverview.dataQuality")} value={`${coverage}%`} tone={coverage < 100 ? "warning" : undefined} />
                <div className="chat-usage-route">
                  <span>{t("chat.usageOverview.route")}</span>
                  <strong title={dominantRoute}>{dominantRoute}</strong>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {summary && rows?.kind === "ready" && rows.coverageWarning && (
        <p className="chat-usage-coverage">{t("chat.usageOverview.coverage")}</p>
      )}

      {suggestions.map((suggestion) => (
        <UsageSuggestion
          key={suggestion.suggestion_key}
          suggestion={suggestion}
          context="home"
          threadId={threadId}
          onInstruction={handleInstruction}
          onDismiss={(key) => setSuggestions((items) => items.filter((item) => item.suggestion_key !== key))}
        />
      ))}
    </section>
  );
}

function UsageMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning";
}) {
  return (
    <div className={`chat-usage-metric${tone ? ` is-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
