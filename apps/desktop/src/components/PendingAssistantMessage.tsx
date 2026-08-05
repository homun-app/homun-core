import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AssistantThinkingState, type ChatStreamStatus } from "./AssistantThinkingState";

interface PendingAssistantMessageProps {
  status: ChatStreamStatus | null;
}

export function PendingAssistantMessage({ status }: PendingAssistantMessageProps) {
  const { t } = useTranslation();

  return (
    <div className="thread-message-row">
      <article className="message chat-message-agent pending" aria-live="polite">
        <header className="assistant-label">
          <Sparkles size={17} />
          <strong>assistant</strong>
          <span>{t("chat.roleAssistant")}</span>
        </header>
        <AssistantThinkingState status={status} />
      </article>
    </div>
  );
}
