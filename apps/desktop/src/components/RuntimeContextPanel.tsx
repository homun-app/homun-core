import { useTranslation } from "react-i18next";
import type { RuntimeContextView } from "../lib/runtimeContext";

interface RuntimeContextPanelProps {
  value: RuntimeContextView;
  loading: boolean;
  error: boolean;
}

function formatTokens(value: number | null, unavailable: string) {
  return value === null ? unavailable : new Intl.NumberFormat().format(value);
}

function formatCompactTokens(value: number | null, unavailable: string) {
  if (value === null) return unavailable;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat().format(value);
}

export function RuntimeContextPanel({ value, loading, error }: RuntimeContextPanelProps) {
  const { t } = useTranslation();
  const unavailable = t("composer.runtime.unavailable");
  const contributionRows = [
    ["conversation", t("composer.runtime.conversation"), value.contributions.conversation, "conversation"],
    ["compactedSummary", t("composer.runtime.compactedSummary"), value.contributions.compactedSummary, "summary"],
    ["filesArtifacts", t("composer.runtime.filesArtifacts"), value.contributions.filesArtifacts, "files"],
    ["authorizedMemory", t("composer.runtime.authorizedMemory"), value.contributions.authorizedMemory, "memory"],
    ["systemTools", t("composer.runtime.systemTools"), value.contributions.systemTools, "system"],
  ] as const;
  const usedPercent = value.percent === null ? null : Math.round(value.percent);
  const usageLabel = value.usedTokens === null || value.contextWindow === null
    ? unavailable
    : `~${formatCompactTokens(value.usedTokens, unavailable)} / ${formatCompactTokens(value.contextWindow, unavailable)} tokens`;
  const contributionSegments = contributionRows
    .filter(([, , contribution]) => contribution && value.contextWindow && value.contextWindow > 0)
    .map(([key, label, contribution, tone]) => ({
      key,
      label,
      tone,
      percent: Math.max(1, Math.min(100, ((contribution?.estimatedTokens ?? 0) / (value.contextWindow ?? 1)) * 100)),
    }));
  const facts = [
    [t("composer.runtime.effectiveModel"), value.effectiveModel],
    [t("composer.runtime.nextTurnModel"), value.selectedNextModel ?? t("composer.auto")],
    [t("composer.runtime.provider"), value.provider],
    [t("composer.runtime.locality"), value.locality],
    [t("composer.runtime.role"), value.role],
    [t("composer.runtime.contextWindow"), formatTokens(value.contextWindow, unavailable)],
    [
      t("composer.runtime.usedInput"),
      value.usedTokens === null
        ? unavailable
        : value.percent === null
          ? formatTokens(value.usedTokens, unavailable)
          : t("composer.runtime.usedInputValue", {
              tokens: formatTokens(value.usedTokens, unavailable),
              percent: Math.round(value.percent),
            }),
    ],
    [t("composer.runtime.compaction"), value.compacted
      ? t("composer.runtime.applied")
      : t("composer.runtime.notApplied")],
  ] as const;

  return (
    <section
      className="composer-runtime-panel composer-menu-list"
      aria-labelledby="runtime-context-title"
      aria-live="polite"
    >
      <h2 id="runtime-context-title" className="composer-model-group-label">
        {t("composer.runtimeContext")}
      </h2>
      {loading ? <p className="composer-menu-empty">{t("composer.runtime.loading")}</p> : null}
      {error ? <p className="composer-error">{t("composer.runtime.error")}</p> : null}
      <div className="composer-runtime-usage">
        <div className="composer-runtime-usage-head">
          <span>{usedPercent === null ? unavailable : `${usedPercent}% Full`}</span>
          <span>{usageLabel}</span>
        </div>
        <div
          className="composer-runtime-usage-bar"
          role="progressbar"
          aria-label={t("composer.runtime.usedInput")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usedPercent ?? undefined}
        >
          <div className="composer-runtime-usage-fill" style={{ width: `${usedPercent ?? 0}%` }} />
          <div className="composer-runtime-segments" aria-hidden="true">
            {contributionSegments.map((segment) => (
              <span
                className={`composer-runtime-segment composer-runtime-segment--${segment.tone}`}
                key={segment.key}
                title={segment.label}
                style={{ width: `${segment.percent}%` }}
              />
            ))}
          </div>
        </div>
      </div>
      <dl className="composer-runtime-contributions">
        {contributionRows.map(([key, label, contribution, tone]) => (
          <div className="composer-runtime-contribution" key={key}>
            <dt>
              <span className={`composer-runtime-swatch composer-runtime-swatch--${tone}`} />
              <span>{label}</span>
            </dt>
            <dd>
              <span>{contribution ? formatTokens(contribution.estimatedTokens, unavailable) : unavailable}</span>
              {contribution?.source === "prompt_snapshot_estimate" ? (
                <small>{t("composer.runtime.promptEstimate")}</small>
              ) : contribution?.source === "provider_reported" ? (
                <small>{t("composer.runtime.providerReported")}</small>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      <dl className="composer-runtime-facts">
        {facts.map(([label, content]) => (
          <div className="composer-runtime-row" key={label}>
            <dt className="menu-item__label">{label}</dt>
            <dd className="menu-item__trailing">{content ?? unavailable}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
