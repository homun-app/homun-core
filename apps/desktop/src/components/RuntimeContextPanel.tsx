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

export function RuntimeContextPanel({ value, loading, error }: RuntimeContextPanelProps) {
  const { t } = useTranslation();
  const unavailable = t("composer.runtime.unavailable");
  const contributionRows = [
    ["conversation", t("composer.runtime.conversation"), value.contributions.conversation],
    ["compactedSummary", t("composer.runtime.compactedSummary"), value.contributions.compactedSummary],
    ["filesArtifacts", t("composer.runtime.filesArtifacts"), value.contributions.filesArtifacts],
    ["authorizedMemory", t("composer.runtime.authorizedMemory"), value.contributions.authorizedMemory],
    ["systemTools", t("composer.runtime.systemTools"), value.contributions.systemTools],
  ] as const;
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
      <dl>
        {facts.map(([label, content]) => (
          <div className="composer-runtime-row" key={label}>
            <dt className="menu-item__label">{label}</dt>
            <dd className="menu-item__trailing">{content ?? unavailable}</dd>
          </div>
        ))}
      </dl>
      <div className="composer-model-group-label">{t("composer.runtime.contributions")}</div>
      <dl>
        {contributionRows.map(([key, label, contribution]) => (
          <div className="composer-runtime-row" key={key}>
            <dt className="menu-item__label">{label}</dt>
            <dd className="menu-item__trailing">
              {contribution ? (
                <>
                  <span>{formatTokens(contribution.estimatedTokens, unavailable)}</span>
                  {contribution.source === "prompt_snapshot_estimate" ? (
                    <small>{t("composer.runtime.promptEstimate")}</small>
                  ) : contribution.source === "provider_reported" ? (
                    <small>{t("composer.runtime.providerReported")}</small>
                  ) : null}
                </>
              ) : unavailable}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
