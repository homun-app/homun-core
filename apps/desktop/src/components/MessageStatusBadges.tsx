import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

interface MessageStatusBadgesProps {
  incomplete: boolean;
  autoContinuing: boolean;
}

export function MessageStatusBadges({ incomplete, autoContinuing }: MessageStatusBadgesProps) {
  const { t } = useTranslation();

  if (!incomplete && !autoContinuing) return null;

  return (
    <>
      {incomplete && (
        <div className="message-incomplete-note" role="note">
          {t("chat.responseLikelyInterrupted")}
        </div>
      )}
      {autoContinuing && (
        <div className="auto-continue-status" role="status" aria-live="polite">
          <Sparkles size={14} />
          <span>{t("chat.autoCompleting")}</span>
        </div>
      )}
    </>
  );
}
