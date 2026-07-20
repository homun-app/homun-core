import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  coreBridge,
  type ApplyInstruction,
  type ModelUsageSuggestion,
  type SuggestionActionScope,
  type SuggestionFact,
} from "../lib/coreBridge";

type UsageSuggestionProps = {
  suggestion: ModelUsageSuggestion;
  context: "home" | "settings";
  threadId?: string;
  onInstruction: (instruction: ApplyInstruction) => Promise<void> | void;
  onDismiss: (key: string) => void;
};

export function UsageSuggestion({
  suggestion,
  context,
  threadId,
  onInstruction,
  onDismiss,
}: UsageSuggestionProps) {
  const { t } = useTranslation();
  const [pendingAction, setPendingAction] = useState<SuggestionActionScope | null>(null);
  const [dismissPending, setDismissPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissTimerRef = useRef<number | null>(null);

  const finalizeDismiss = () => {
    if (dismissTimerRef.current != null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    void coreBridge.dismissUsageSuggestion(suggestion.suggestion_key)
      .then(() => onDismiss(suggestion.suggestion_key))
      .catch((reason) => {
        setDismissPending(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  useEffect(() => () => {
    if (dismissTimerRef.current != null) finalizeDismiss();
  // The pending timer belongs to this suggestion instance and is finalized on navigation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function beginDismiss() {
    setDismissPending(true);
    setError(null);
    dismissTimerRef.current = window.setTimeout(finalizeDismiss, 5_000);
  }

  function undoDismiss() {
    if (dismissTimerRef.current != null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    setDismissPending(false);
  }

  async function confirm() {
    if (!pendingAction || busy) return;
    setBusy(true);
    setError(null);
    try {
      const instruction = await coreBridge.applyUsageSuggestion(suggestion.suggestion_key, {
        confirmed: true,
        action: pendingAction,
        ...(threadId ? { thread_id: threadId } : {}),
      });
      await onInstruction(instruction);
      onDismiss(suggestion.suggestion_key);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setPendingAction(null);
    }
  }

  if (dismissPending) {
    return <div className="usage-suggestion-undo" aria-live="polite">
      <span>{t("usageSuggestions.dismissed")}</span>
      <button type="button" onClick={undoDismiss}>{t("usageSuggestions.undo")}</button>
    </div>;
  }

  const action: SuggestionActionScope = context === "home"
    ? "use_for_task"
    : "change_role_preference";
  const canApply = suggestion.action_scopes.includes(action);

  return <section className="usage-suggestion" aria-label={t("usageSuggestions.title")}>
    <div className="usage-suggestion-copy">
      <span>{t("usageSuggestions.title")}</span>
      <strong>{suggestion.target_model}</strong>
      <small>{suggestion.target_provider} · {t(`usageSuggestions.confidence.${suggestion.confidence}`)}</small>
    </div>
    <ul>{suggestion.facts.slice(0, 2).map((fact, index) =>
      <li key={`${fact.kind}-${index}`}>{factText(fact, t)}</li>
    )}</ul>
    <div className="usage-suggestion-actions">
      {canApply && <button type="button" onClick={() => setPendingAction(action)}>
        {t(`usageSuggestions.actions.${action}`)}
      </button>}
      <button type="button" onClick={beginDismiss}>{t("usageSuggestions.actions.dismiss")}</button>
    </div>
    {pendingAction && <div
      className="usage-suggestion-confirm"
      role="dialog"
      aria-modal="true"
      aria-label={t("usageSuggestions.confirm.title")}
      tabIndex={-1}
      onKeyDown={(event) => { if (event.key === "Escape") setPendingAction(null); }}
    >
      <strong>{t("usageSuggestions.confirm.title")}</strong>
      <p>{t("usageSuggestions.confirm.body", {
        current: suggestion.current_model,
        target: suggestion.target_model,
        scope: t(`usageSuggestions.actions.${pendingAction}`),
      })}</p>
      <div>
        <button type="button" disabled={busy} onClick={() => setPendingAction(null)}>{t("usageSuggestions.confirm.cancel")}</button>
        <button type="button" disabled={busy} onClick={() => void confirm()}>{t("usageSuggestions.confirm.apply")}</button>
      </div>
    </div>}
    {error && <p className="usage-suggestion-error" role="alert">{t("usageSuggestions.error")}: {error}</p>}
  </section>;
}

function factText(fact: SuggestionFact, t: (key: string, options?: Record<string, unknown>) => string) {
  const percent = fact.delta_percent == null ? null : Math.abs(Math.round(fact.delta_percent));
  return t(`usageSuggestions.facts.${fact.kind}`, {
    percent,
    provenance: t(`usageSuggestions.provenance.${fact.provenance}`, {
      defaultValue: t("usageSuggestions.provenance.unavailable"),
    }),
  });
}
