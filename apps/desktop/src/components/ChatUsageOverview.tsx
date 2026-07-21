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
import { routeLabel } from "../lib/usageCalendar";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [suggestions, setSuggestions] = useState<ModelUsageSuggestion[]>([]);
  const generationRef = useRef(0);
  const suggestionGenerationRef = useRef(0);

  const load = useCallback(async (selectedWindow: UsageWindow) => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(false);
    try {
      const timezoneOffsetMinutes = -new Date().getTimezoneOffset();
      const [nextSummary, nextDaily] = await Promise.all([
        coreBridge.usageSummary(selectedWindow),
        coreBridge.usageDaily(selectedWindow, timezoneOffsetMinutes),
      ]);
      if (generationRef.current === generation) {
        setSummary(nextSummary);
        setDaily(nextDaily);
      }
    } catch {
      if (generationRef.current === generation) setError(true);
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(window);
    return () => { generationRef.current += 1; };
  }, [load, window]);

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
        dominant_provider: summary.dominant_provider,
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
        {loading && !summary && t("chat.usageOverview.loading")}
        {error && (
          <span>
            {t("chat.usageOverview.error")}{" "}
            <button type="button" onClick={() => void load(window)}>{t("chat.usageOverview.retry")}</button>
          </span>
        )}
      </div>

      {rows?.kind === "empty" && <p className="chat-usage-empty">{t("chat.usageOverview.empty")}</p>}

      {rows?.kind === "ready" && summary && daily && (
        <div className="chat-usage-infographic">
          <UsageCalendar
            series={daily}
            window={window}
            locale={i18n.resolvedLanguage}
            density="compact"
          />
          <div className="chat-usage-summary">
            <UsageMetric label={t("settings.usage.metrics.calls")} value={formatCount(summary.logical_calls, i18n.resolvedLanguage)} />
            <UsageMetric label={t("chat.usageOverview.tokens")} value={formatCount(totalTokens, i18n.resolvedLanguage)} />
            <UsageMetric label={t("chat.usageOverview.cost")} value={formatMicrousd(summary.cost_microusd, i18n.resolvedLanguage)} />
            <UsageMetric label={t("chat.usageOverview.dataQuality")} value={`${coverage}%`} tone={coverage < 100 ? "warning" : undefined} />
            <div className="chat-usage-route">
              <span>{t("chat.usageOverview.route")}</span>
              <strong title={dominantRoute}>{dominantRoute}</strong>
            </div>
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
