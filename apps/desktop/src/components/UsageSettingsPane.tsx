import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  coreBridge,
  type UsageModelRow,
  type UsageProcessRow,
  type UsageProviderRow,
  type UsageSummaryView,
  type UsageWindow,
  type SetProviderUsagePolicyInput,
  type ApplyInstruction,
  type ModelUsageSuggestion,
} from "../lib/coreBridge";
import { UsageSuggestion } from "./UsageSuggestion";
import {
  clampPercent,
  formatCount,
  formatMicrousd,
  providerSnapshotState,
  remainingBudgetPercent,
} from "../lib/usageViewModel";

type UsageTab = "overview" | "models" | "providers" | "processes";

type UsageData = {
  summary: UsageSummaryView;
  models: UsageModelRow[];
  providers: UsageProviderRow[];
  processes: UsageProcessRow[];
  suggestions: ModelUsageSuggestion[];
};

const WINDOWS: UsageWindow[] = ["7d", "30d", "all"];
const TABS: UsageTab[] = ["overview", "models", "providers", "processes"];

export function UsageSettingsPane() {
  const { t, i18n } = useTranslation();
  const [window, setWindow] = useState<UsageWindow>("30d");
  const [tab, setTab] = useState<UsageTab>("overview");
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [suggestionStatus, setSuggestionStatus] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const load = useCallback(async (selectedWindow: UsageWindow) => {
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const [summary, models, providers, processes, suggestions] = await Promise.all([
        coreBridge.usageSummary(selectedWindow),
        coreBridge.usageModels(selectedWindow),
        coreBridge.usageProviders(selectedWindow),
        coreBridge.usageProcesses(selectedWindow),
        coreBridge.usageSuggestions(selectedWindow, "settings").catch(() => []),
      ]);
      if (requestGenerationRef.current === generation) {
        setData({ summary, models, providers, processes, suggestions });
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

  async function handleSuggestionInstruction(instruction: ApplyInstruction) {
    if (instruction.kind !== "change_role_preference") return;
    setSuggestionStatus(null);
    await coreBridge.setRole({
      role: instruction.role,
      provider_id: instruction.provider_id,
      model: instruction.model_id,
    });
    setSuggestionStatus(t("usageSuggestions.preferenceChanged", { role: instruction.role }));
    await load(window);
  }

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
        {suggestionStatus && <span className="usage-success">{suggestionStatus}</span>}
      </div>

      {data && data.suggestions.length > 0 && <div className="usage-settings-suggestions">
        {data.suggestions.map((suggestion) => <UsageSuggestion
          key={suggestion.suggestion_key}
          suggestion={suggestion}
          context="settings"
          onInstruction={handleSuggestionInstruction}
          onDismiss={(key) => setData((current) => current ? {
            ...current,
            suggestions: current.suggestions.filter((item) => item.suggestion_key !== key),
          } : current)}
        />)}
      </div>}

      {data && !isEmpty && (
        <section
          id={`usage-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`usage-tab-${tab}`}
          className="usage-panel"
        >
          {tab === "overview" && (
            <UsageOverview data={data} locale={i18n.resolvedLanguage} />
          )}
          {tab === "models" && (
            <UsageModels rows={data.models} locale={i18n.resolvedLanguage} />
          )}
          {tab === "providers" && (
            <UsageProviders
              rows={data.providers}
              locale={i18n.resolvedLanguage}
              onReload={() => load(window)}
            />
          )}
          {tab === "processes" && (
            <UsageProcesses rows={data.processes} locale={i18n.resolvedLanguage} />
          )}
        </section>
      )}
    </div>
  );
}

function rowTokens(row: UsageModelRow | UsageProcessRow): number {
  return row.input_tokens + row.output_tokens + row.reasoning_tokens;
}

function UsageMeter({ value, label }: { value: number; label: string }) {
  const percent = clampPercent(value);
  return (
    <div className="usage-meter-row">
      <span>{label}</span>
      <span>{percent}%</span>
      <div className="usage-meter" role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function UsageOverview({ data, locale }: { data: UsageData; locale?: string }) {
  const { t } = useTranslation();
  const cost = data.summary.cost_breakdown;
  const estimated = cost.catalog_estimated_microusd + cost.manual_estimated_microusd;
  const dominantModel = [...data.models].sort((a, b) => rowTokens(b) - rowTokens(a))[0]?.key;
  const coverageDate = data.summary.coverage_started_at
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(data.summary.coverage_started_at * 1_000)
    : null;
  return (
    <div data-usage-view="overview" className="usage-overview">
      <div className="usage-metrics">
        <UsageMetric label={t("settings.usage.metrics.calls")} value={formatCount(data.summary.logical_calls, locale)} />
        <UsageMetric label={t("settings.usage.metrics.attempts")} value={formatCount(data.summary.attempts, locale)} />
        <UsageMetric label={t("settings.usage.metrics.inputTokens")} value={formatCount(data.summary.input_tokens, locale)} />
        <UsageMetric label={t("settings.usage.metrics.outputTokens")} value={formatCount(data.summary.output_tokens, locale)} />
        <UsageMetric label={t("settings.usage.metrics.reasoningTokens")} value={formatCount(data.summary.reasoning_tokens, locale)} />
        <UsageMetric label={t("settings.usage.metrics.cacheTokens")} value={formatCount(data.summary.cache_read_tokens + data.summary.cache_write_tokens, locale)} />
        <UsageMetric label={t("settings.usage.metrics.providers")} value={String(data.providers.length)} />
        <UsageMetric label={t("settings.usage.metrics.dominantModel")} value={dominantModel ?? "—"} />
      </div>

      <section className="usage-section usage-costs" aria-labelledby="usage-cost-title">
        <h3 id="usage-cost-title">{t("settings.usage.cost.title")}</h3>
        <dl>
          <div className="reported"><dt>{t("settings.usage.cost.reported")}</dt><dd>{formatMicrousd(cost.provider_reported_microusd, locale)}</dd></div>
          <div className="estimated"><dt>{t("settings.usage.cost.estimated")}</dt><dd>{formatMicrousd(estimated, locale)}</dd></div>
          <div className="unknown"><dt>{t("settings.usage.cost.unknown")}</dt><dd>{cost.unknown_cost_attempts}</dd></div>
          <div><dt>{t("settings.usage.cost.notBilled")}</dt><dd>{cost.not_billed_attempts}</dd></div>
        </dl>
      </section>

      <section className="usage-section usage-coverage" aria-labelledby="usage-coverage-title">
        <h3 id="usage-coverage-title">{t("settings.usage.coverage.title")}</h3>
        <UsageMeter value={data.summary.usage_coverage_percent} label={t("settings.usage.coverage.usage")} />
        <UsageMeter value={cost.cost_coverage_percent} label={t("settings.usage.coverage.cost")} />
        {(data.summary.usage_coverage_percent < 100 || cost.cost_coverage_percent < 100) && (
          <p className="usage-warning">{t("settings.usage.coverage.incomplete")}</p>
        )}
        {coverageDate && <p className="usage-authority">{t("settings.usage.coverage.authoritativeSince", { date: coverageDate })}</p>}
      </section>
    </div>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return <div className="usage-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function UsageModels({ rows, locale }: { rows: UsageModelRow[]; locale?: string }) {
  const { t } = useTranslation();
  const sorted = [...rows].sort((a, b) => rowTokens(b) - rowTokens(a));
  return (
    <div data-usage-view="models" className="usage-table-wrap">
      <table className="usage-table usage-model-table">
        <thead><tr>
          <th>{t("settings.usage.models.model")}</th>
          <th>{t("settings.usage.models.calls")}</th>
          <th aria-sort="descending">{t("settings.usage.models.tokens")}</th>
          <th>{t("settings.usage.models.cost")}</th>
          <th className="latency-p50">{t("settings.usage.models.p50")}</th>
          <th className="latency-p95">{t("settings.usage.models.p95")}</th>
          <th>{t("settings.usage.models.success")}</th>
          <th className="retry-count">{t("settings.usage.models.retries")}</th>
          <th className="fallback-count">{t("settings.usage.models.fallbacks")}</th>
        </tr></thead>
        <tbody>{sorted.map((row) => {
          const success = row.attempts ? Math.round((row.successful_attempts / row.attempts) * 100) : 0;
          return <tr key={row.key}>
            <th scope="row">{row.key}</th>
            <td>{formatCount(row.logical_calls, locale)}</td>
            <td>{formatCount(rowTokens(row), locale)}</td>
            <td>{formatMicrousd(row.cost_microusd, locale)}</td>
            <td className="latency-p50">—</td><td className="latency-p95">—</td>
            <td>{success}%</td>
            <td className="retry-count">{Math.max(0, row.attempts - row.logical_calls)}</td>
            <td className="fallback-count">—</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}

function UsageProviders({ rows, locale, onReload }: {
  rows: UsageProviderRow[];
  locale?: string;
  onReload: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function refresh(providerId: string) {
    setBusy(providerId); setActionError(null);
    try { await coreBridge.refreshProviderUsage(providerId); await onReload(); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  }

  return <div data-usage-view="providers" className="usage-provider-list">
    {actionError && <p className="usage-error" role="alert">{actionError}</p>}
    {rows.map((row) => {
      const snapshot = row.account_snapshot[0];
      const snapshotView = providerSnapshotState(snapshot);
      const unsupported = snapshot?.status === "unsupported";
      const spent = row.homun_usage.cost_microusd;
      const remaining = remainingBudgetPercent(row.manual_policy?.monthly_budget_microusd, spent, row.homun_usage.cost_breakdown.cost_coverage_percent);
      return <section key={row.provider_id} className="usage-provider-row">
        <header><h3>{row.provider_id}</h3><button type="button" disabled={busy === row.provider_id || unsupported} onClick={() => void refresh(row.provider_id)}>{t("settings.usage.actions.refresh")}</button></header>
        <div className="usage-provider-columns">
          <div><h4>{t("settings.usage.provider.measured")}</h4><dl>
            <div><dt>{t("settings.usage.metrics.calls")}</dt><dd>{row.homun_usage.logical_calls}</dd></div>
            <div><dt>{t("settings.usage.models.tokens")}</dt><dd>{formatCount(rowTokens(row.homun_usage), locale)}</dd></div>
            <div><dt>{t("settings.usage.models.cost")}</dt><dd>{formatMicrousd(spent, locale)}</dd></div>
            <div><dt>{t("settings.usage.coverage.cost")}</dt><dd>{row.homun_usage.cost_breakdown.cost_coverage_percent}%</dd></div>
          </dl></div>
          <div><h4>{t("settings.usage.provider.account")}</h4>
            <p className={`usage-account-state ${snapshotView.tone}`}>{t(`settings.usage.account.${snapshot?.status ?? "unsupported"}`)}{snapshotView.stale ? ` · ${t("settings.usage.states.stale")}` : ""}</p>
            {snapshot?.used_value != null && <p>{formatMicrousd(snapshot.used_value, locale)} {t("settings.usage.provider.used")}</p>}
            {snapshot?.limit_value != null && <p>{formatMicrousd(snapshot.limit_value, locale)} {t("settings.usage.provider.providerLimit")}</p>}
            {snapshot?.observed_at ? <small>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(snapshot.observed_at * 1_000)}</small> : null}
          </div>
          <div><h4>{t("settings.usage.provider.manualBudget")}</h4>
            <p>{row.manual_policy?.monthly_budget_microusd != null ? formatMicrousd(row.manual_policy.monthly_budget_microusd, locale) : t("settings.usage.provider.notSet")}</p>
            {remaining == null && row.manual_policy?.monthly_budget_microusd ? <p className="usage-warning">{t("settings.usage.provider.coverageRequired")}</p> : null}
            {remaining != null && <p>{t("settings.usage.provider.manualRemaining", { percent: remaining })}</p>}
            <button type="button" aria-expanded={editing === row.provider_id} onClick={() => setEditing(editing === row.provider_id ? null : row.provider_id)}>{t("settings.usage.actions.editBudget")}</button>
          </div>
        </div>
        {editing === row.provider_id && <ProviderPolicyEditor row={row} onSaved={async () => { setEditing(null); await onReload(); }} />}
      </section>;
    })}
  </div>;
}

function ProviderPolicyEditor({ row, onSaved }: { row: UsageProviderRow; onSaved: () => Promise<void> | void }) {
  const { t } = useTranslation();
  const existing = row.manual_policy;
  const [budget, setBudget] = useState(existing?.monthly_budget_microusd ? String(existing.monthly_budget_microusd / 1_000_000) : "");
  const [resetDay, setResetDay] = useState(String(existing?.reset_day ?? 1));
  const [timezone, setTimezone] = useState(existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [threshold, setThreshold] = useState(String(existing?.alert_threshold_percent ?? 80));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const dollars = budget.trim() === "" ? null : Number(budget);
    const day = Number(resetDay); const alert = Number(threshold);
    if ((dollars != null && (!Number.isFinite(dollars) || dollars < 0)) || day < 1 || day > 28 || alert < 1 || alert > 100 || !timezone.trim()) {
      setError(t("settings.usage.policy.invalid")); return;
    }
    const policy: SetProviderUsagePolicyInput = {
      monthly_budget_microusd: dollars == null ? null : Math.round(dollars * 1_000_000),
      currency: "USD",
      reset_day: day,
      timezone: timezone.trim(),
      alert_threshold_percent: alert,
      pricing_overrides: existing?.pricing_overrides ?? [],
    };
    setSaving(true); setError(null);
    try { await coreBridge.setProviderUsagePolicy(row.provider_id, policy); await onSaved(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }

  return <div className="usage-policy-editor">
    <label>{t("settings.usage.policy.monthlyBudget")}<input inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} /></label>
    <label>{t("settings.usage.policy.resetDay")}<input type="number" min={1} max={28} value={resetDay} onChange={(event) => setResetDay(event.target.value)} /></label>
    <label>{t("settings.usage.policy.timezone")}<input value={timezone} onChange={(event) => setTimezone(event.target.value)} /></label>
    <label>{t("settings.usage.policy.threshold")}<input type="number" min={1} max={100} value={threshold} onChange={(event) => setThreshold(event.target.value)} /></label>
    {error && <p className="usage-error" role="alert">{error}</p>}
    <button type="button" disabled={saving} onClick={() => void save()}>{saving ? t("settings.usage.actions.saving") : t("settings.usage.actions.save")}</button>
  </div>;
}

const PROCESS_FAMILIES = {
  chat: ["chat_response", "title_generation", "intent_routing"],
  memory: ["memory_extraction", "memory_recall", "memory_compaction", "embedding"],
  planning: ["planning", "evaluation"],
  subagents: ["subagent"], automations: ["automation"],
  artifacts: ["artifact_generation", "vision_analysis"], other: ["other"],
} as const;

function UsageProcesses({ rows, locale }: { rows: UsageProcessRow[]; locale?: string }) {
  const { t } = useTranslation();
  return <div data-usage-view="processes" className="usage-process-list">
    {Object.entries(PROCESS_FAMILIES).map(([family, purposes]) => {
      const members = rows.filter((row) => (purposes as readonly string[]).includes(row.key));
      if (!members.length) return null;
      const calls = members.reduce((sum, row) => sum + row.logical_calls, 0);
      const attempts = members.reduce((sum, row) => sum + row.attempts, 0);
      const tokens = members.reduce((sum, row) => sum + rowTokens(row), 0);
      const cost = members.reduce((sum, row) => sum + row.cost_microusd, 0);
      return <section key={family} className="usage-process-row">
        <h3>{t(`settings.usage.processes.${family}`)}</h3>
        <dl><div><dt>{t("settings.usage.metrics.calls")}</dt><dd>{calls}</dd></div><div><dt>{t("settings.usage.metrics.attempts")}</dt><dd>{attempts}</dd></div><div><dt>{t("settings.usage.models.tokens")}</dt><dd>{formatCount(tokens, locale)}</dd></div><div><dt>{t("settings.usage.models.cost")}</dt><dd>{formatMicrousd(cost, locale)}</dd></div></dl>
        <details><summary>{t("settings.usage.processes.details")}</summary>{members.map((member) => <p key={member.key}>{member.key}: {member.attempts}</p>)}</details>
      </section>;
    })}
  </div>;
}
