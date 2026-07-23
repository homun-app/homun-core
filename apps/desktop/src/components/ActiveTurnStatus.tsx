import { Activity, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface ActiveTurnStatusProps {
  phase: string;
  detail?: string;
  elapsedSeconds: number;
  attempt: number;
  activityCount: number;
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
  onOpenActivity,
  onStop,
}: ActiveTurnStatusProps) {
  const { t } = useTranslation();

  return (
    <div
      className="active-turn-status"
      role="status"
      aria-live="polite"
      aria-label={t("chat.stillWorking")}
      title={detail}
    >
      <span className="active-turn-pulse" aria-hidden="true" />
      <span className="active-turn-copy">
        <strong>{phase}</strong>
      </span>
      <span className="active-turn-meta">
        <span>{formatElapsed(elapsedSeconds)}</span>
        {attempt > 1 && <span>{t("chat.attemptN", { count: attempt })}</span>}
      </span>
      <button
        type="button"
        className="active-turn-activity"
        aria-label={t("chat.inspector.views.activity")}
        onClick={onOpenActivity}
      >
        <Activity size={14} />
        <span>{t("chat.inspector.views.activity")}</span>
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
