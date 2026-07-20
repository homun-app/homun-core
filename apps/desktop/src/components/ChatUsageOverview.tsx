import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { coreBridge, type UsageSummaryView, type UsageWindow } from "../lib/coreBridge";
import { compactUsageRows, formatMicrousd } from "../lib/usageViewModel";

const WINDOWS: UsageWindow[] = ["7d", "30d", "all"];

export function ChatUsageOverview() {
  const { t, i18n } = useTranslation();
  const [window, setWindow] = useState<UsageWindow>("30d");
  const [summary, setSummary] = useState<UsageSummaryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generationRef = useRef(0);

  const load = useCallback(async (selectedWindow: UsageWindow) => {
    const generation = ++generationRef.current;
    setLoading(true); setError(false);
    try {
      const next = await coreBridge.usageSummary(selectedWindow);
      if (generationRef.current === generation) setSummary(next);
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

  const rows = summary ? compactUsageRows(summary, i18n.resolvedLanguage) : null;
  const cost = summary?.cost_breakdown;
  const estimated = (cost?.catalog_estimated_microusd ?? 0) + (cost?.manual_estimated_microusd ?? 0);

  return <section className="chat-usage-overview" aria-label={t("chat.usageOverview.title")}>
    <div className="chat-usage-window" aria-label={t("chat.usageOverview.period")}>{WINDOWS.map((item) =>
      <button key={item} type="button" aria-pressed={window === item} onClick={() => setWindow(item)}>{t(`chat.usageOverview.windows.${item}`)}</button>
    )}</div>
    <div className="chat-usage-status" aria-live="polite">
      {loading && !summary && t("chat.usageOverview.loading")}
      {error && <span>{t("chat.usageOverview.error")} <button type="button" onClick={() => void load(window)}>{t("chat.usageOverview.retry")}</button></span>}
    </div>
    {rows?.kind === "empty" && <p className="chat-usage-empty">{t("chat.usageOverview.empty")}</p>}
    {rows?.kind === "ready" && summary && <>
      <div className="chat-usage-metrics">
        <UsageCell label={t("chat.usageOverview.tokens")} value={rows.tokens} />
        <UsageCell label={t("chat.usageOverview.cost")} value={`${formatMicrousd(cost?.provider_reported_microusd ?? 0, i18n.resolvedLanguage)} ${t("settings.usage.cost.reported")}`} detail={`${formatMicrousd(estimated, i18n.resolvedLanguage)} ${t("settings.usage.cost.estimated")}${cost?.unknown_cost_attempts ? ` · ${cost.unknown_cost_attempts} ${t("settings.usage.cost.unknown")}` : ""}`} />
        <UsageCell label={t("chat.usageOverview.providers")} value={String(rows.providers)} />
        <UsageCell label={t("chat.usageOverview.model")} value={rows.model} />
        <UsageCell label={t("chat.usageOverview.trend")} value={rows.trend == null ? "—" : `${rows.trend > 0 ? "+" : ""}${rows.trend}%`} />
      </div>
      {rows.coverageWarning && <p className="chat-usage-coverage">{t("chat.usageOverview.coverage")}</p>}
    </>}
  </section>;
}

function UsageCell({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}
