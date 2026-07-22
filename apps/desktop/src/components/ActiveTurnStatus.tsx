import { Activity, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface ActiveTurnStatusProps {
  phase: string;
  detail?: string;
  elapsedSeconds: number;
  attempt: number;
  activityCount: number;
  variant: "assistant-footer" | "composer-bar";
  onOpenActivity(): void;
  onStop(): void;
}

function formatElapsed(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${remainder}s`;
}

export function ActiveTurnStatus({
  phase,
  detail,
  elapsedSeconds,
  attempt,
  activityCount,
  variant,
  onOpenActivity,
  onStop,
}: ActiveTurnStatusProps) {
  const { t } = useTranslation();

  return (
    <div
      className={`active-turn-status ${variant}`}
      role="status"
      aria-live="polite"
    >
      <span className="active-turn-pulse" aria-hidden="true" />
      <span className="active-turn-copy">
        <strong>{t("chat.stillWorking")}</strong>
        <span>{phase}</span>
        {detail && <small>{detail}</small>}
      </span>
      <span className="active-turn-meta">
        <span>{formatElapsed(elapsedSeconds)}</span>
        <span>{t("chat.attemptN", { count: Math.max(1, attempt) })}</span>
      </span>
      <button type="button" className="active-turn-activity" onClick={onOpenActivity}>
        <Activity size={14} />
        {/* UI contract: Attività is rendered through the active locale. */}
        <span>{t("chat.inspector.activity")}</span>
        {activityCount > 0 && <small>{activityCount}</small>}
      </button>
      <button
        type="button"
        className="active-turn-stop"
        aria-label={t("chat.stop")}
        title={t("chat.stop")}
        onClick={onStop}
      >
        <Square size={12} fill="currentColor" />
      </button>
    </div>
  );
}
