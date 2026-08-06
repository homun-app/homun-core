import { useCallback, useRef } from "react";
import { coreBridge } from "../lib/coreBridge";
import type { ChatMessage } from "../types";

interface UseChatAutoTitleOptions {
  threadId: string;
}

export function useChatAutoTitle({ threadId }: UseChatAutoTitleOptions) {
  const titledThreadsRef = useRef<Set<string>>(new Set());

  const persistAutoTitleForCompletedTurn = useCallback(
    async (
      promptMessages: ChatMessage[],
      assistantText: string,
      shouldAutoTitle: boolean,
    ) => {
      if (!shouldAutoTitle) return;
      if (titledThreadsRef.current.has(threadId)) return;
      const firstUser = promptMessages.find(
        (message) => message.role === "user" && Boolean(message.text?.trim()),
      );
      if (!firstUser || !assistantText.trim()) return;
      titledThreadsRef.current.add(threadId);
      try {
        await coreBridge.autoTitleThread(threadId, firstUser.text, assistantText);
      } catch {
        /* keep existing title on failure */
      }
    },
    [threadId],
  );

  return {
    persistAutoTitleForCompletedTurn,
  };
}
