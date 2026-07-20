import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  coreBridge,
  type UsageModelRow,
  type UsageProcessRow,
  type UsageProviderRow,
  type UsageSummaryView,
  type UsageWindow,
} from "../lib/coreBridge";

type UsageTab = "overview" | "models" | "providers" | "processes";

type UsageData = {
  summary: UsageSummaryView;
  models: UsageModelRow[];
  providers: UsageProviderRow[];
  processes: UsageProcessRow[];
};

const WINDOWS: UsageWindow[] = ["7d", "30d", "all"];
const TABS: UsageTab[] = ["overview", "models", "providers", "processes"];

export function UsageSettingsPane() {
  const { t } = useTranslation();
  const [window, setWindow] = useState<UsageWindow>("30d");
  const [tab, setTab] = useState<UsageTab>("overview");
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const load = useCallback(async (selectedWindow: UsageWindow) => {
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const [summary, models, providers, processes] = await Promise.all([
        coreBridge.usageSummary(selectedWindow),
        coreBridge.usageModels(selectedWindow),
        coreBridge.usageProviders(selectedWindow),
        coreBridge.usageProcesses(selectedWindow),
      ]);
      if (requestGenerationRef.current === generation) {
        setData({ summary, models, providers, processes });
      }
    } catch (reason) {
      if (requestGenerationRef.current === generation) {
        setError(reason instanceof Error ? reason.message : t("settings.usage.states.error"));
      }
    } finally {
      if (requestGenerationRef.current === generation) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load(window);
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [load, window]);

  function selectTab(next: UsageTab) {
    setTab(next);
    requestAnimationFrame(() => tabRefs.current[TABS.indexOf(next)]?.focus());
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: UsageTab) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (TABS.indexOf(current) + direction + TABS.length) % TABS.length;
    selectTab(TABS[nextIndex]);
  }

  const isEmpty = data?.summary.attempts === 0;

  return (
    <div className="usage-surface">
      <div className="usage-toolbar">
        <div className="usage-window-filter" aria-label={t("settings.usage.windowLabel")}>
          {WINDOWS.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={window === item}
              className={window === item ? "active" : ""}
              onClick={() => setWindow(item)}
            >
              {t(`settings.usage.windows.${item}`)}
            </button>
          ))}
        </div>
        {loading && data && <span className="usage-busy" aria-hidden="true" />}
      </div>

      <div className="usage-tabs" role="tablist" aria-label={t("settings.usage.tabs.label")}>
        {TABS.map((item, index) => (
          <button
            key={item}
            ref={(node) => { tabRefs.current[index] = node; }}
            type="button"
            role="tab"
            id={`usage-tab-${item}`}
            aria-controls={`usage-panel-${item}`}
            aria-selected={tab === item}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => selectTab(item)}
            onKeyDown={(event) => onTabKeyDown(event, item)}
          >
            {t(`settings.usage.tabs.${item}`)}
          </button>
        ))}
      </div>

      <div className="usage-status" aria-live="polite">
        {loading && !data && t("settings.usage.states.loading")}
        {error && <span className="usage-error">{t("settings.usage.states.error")}: {error}</span>}
        {!loading && !error && isEmpty && t("settings.usage.states.empty")}
      </div>

      {data && !isEmpty && (
        <section
          id={`usage-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`usage-tab-${tab}`}
          className="usage-panel"
        >
          {tab === "overview" && <div data-usage-view="overview">{data.summary.attempts}</div>}
          {tab === "models" && <div data-usage-view="models">{data.models.length}</div>}
          {tab === "providers" && <div data-usage-view="providers">{data.providers.length}</div>}
          {tab === "processes" && <div data-usage-view="processes">{data.processes.length}</div>}
        </section>
      )}
    </div>
  );
}
