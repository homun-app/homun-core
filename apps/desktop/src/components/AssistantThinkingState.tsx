import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type ChatStreamPhase = "accepted" | "thinking" | "writing" | "recalling";

export interface ChatStreamStatus {
  requestId: string;
  phase: ChatStreamPhase;
  title: string;
  detail: string;
}

export function AssistantThinkingState({ status }: { status: ChatStreamStatus | null }) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => {
      if (startRef.current) setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [status?.requestId, status?.phase]);

  return (
    <div className="assistant-thinking-state" aria-live="polite">
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="thinking-label">
        {status?.title ?? t("chat.thinking")}
        {elapsed > 0 && <span className="thinking-elapsed"> {elapsed}s</span>}
      </span>
      {status?.detail && <span className="thinking-detail">{status.detail}</span>}
    </div>
  );
}
