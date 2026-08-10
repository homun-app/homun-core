import { AlertCircle, BadgeCheck, CircleX, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CoreUncertainEffectOutcome } from "../lib/coreBridge";
import type { UncertainEffectItem } from "../types";

export function InlineUncertainEffectPanel({
  effects,
  busyId,
  hasError,
  onResolve,
}: {
  effects: UncertainEffectItem[];
  busyId: string | null;
  hasError: boolean;
  onResolve: (
    effect: UncertainEffectItem,
    outcome: CoreUncertainEffectOutcome,
  ) => void;
}) {
  const { t } = useTranslation();
  if (effects.length === 0) return null;

  return (
    <section
      className="inline-effect-verification"
      aria-label={t("chat.effectVerificationAria")}
    >
      {hasError && (
        <p className="uncertain-effect-error" role="alert">
          {t("chat.effectResolutionError")}
        </p>
      )}
      {effects.map((effect) => {
        const resolving = busyId === effect.id;
        const disabled = busyId !== null;
        // The browser family is an OUTCOME VERIFICATION gate (did the action
        // really happen on the page?), not an authorization request — it gets
        // dedicated copy so users don't read it as "approve to continue".
        const isBrowserFamily = effect.operationFamily === "browser";
        return (
          <article className="uncertain-effect-card" key={effect.id}>
            <header className="uncertain-effect-header">
              <AlertCircle size={17} aria-hidden="true" />
              <strong>
                {isBrowserFamily
                  ? t("chat.effectVerificationTitleBrowser")
                  : effectFamilyLabel(effect.operationFamily, t)}
              </strong>
              {!isBrowserFamily && <span>{t("chat.needsVerification")}</span>}
            </header>
            <p className="inline-effect-copy">
              {isBrowserFamily
                ? t("chat.effectVerificationPromptBrowser")
                : t("chat.effectVerificationPrompt")}
            </p>
            <time dateTime={new Date(effect.uncertainAt * 1_000).toISOString()}>
              {t("chat.uncertainSince", { time: formatEffectTime(effect.uncertainAt) })}
            </time>
            <div className="uncertain-effect-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={disabled}
                onClick={() => onResolve(effect, "not_applied")}
              >
                <CircleX size={16} aria-hidden="true" />
                {t("chat.verifiedNotApplied")}
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={disabled}
                onClick={() => onResolve(effect, "applied")}
              >
                {resolving ? (
                  <Loader2 className="spin" size={16} aria-hidden="true" />
                ) : (
                  <BadgeCheck size={16} aria-hidden="true" />
                )}
                {t("chat.verifiedApplied")}
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function effectFamilyLabel(
  family: UncertainEffectItem["operationFamily"],
  t: (key: string) => string,
) {
  if (family === "browser") return t("chat.effectFamilyBrowser");
  if (family === "channel") return t("chat.effectFamilyChannel");
  if (family === "connector") return t("chat.effectFamilyConnector");
  return t("chat.effectFamilyExternalWrite");
}

function formatEffectTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp * 1_000));
}
