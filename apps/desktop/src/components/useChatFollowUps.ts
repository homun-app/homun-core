import { useCallback, useEffect, useState } from "react";
import { coreBridge } from "../lib/coreBridge";
import type { ChatMessage } from "../types";

interface UseChatFollowUpsOptions {
  previousUserMessageIndex: Map<string, ChatMessage | null>;
  streamingAssistantId: string | null;
  threadMessages: ChatMessage[];
}

export function useChatFollowUps({
  previousUserMessageIndex,
  streamingAssistantId,
  threadMessages,
}: UseChatFollowUpsOptions) {
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [followUpsFor, setFollowUpsFor] = useState<string | null>(null);

  const clearFollowUps = useCallback(() => {
    setFollowUps([]);
  }, []);

  useEffect(() => {
    if (streamingAssistantId) return undefined;
    const latest = [...threadMessages]
      .reverse()
      .find((message) => message.role === "assistant" && Boolean(message.text?.trim()));
    if (!latest || latest.id === followUpsFor) return undefined;
    const previousUser = previousUserMessageIndex.get(latest.id);
    let cancelled = false;
    setFollowUps([]);
    setFollowUpsFor(latest.id);
    void coreBridge
      .chatSuggestions(previousUser?.text ?? "", latest.text)
      .then((items) => {
        if (!cancelled) setFollowUps(items);
      })
      .catch(() => {
        if (!cancelled) setFollowUps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [followUpsFor, previousUserMessageIndex, streamingAssistantId, threadMessages]);

  return {
    clearFollowUps,
    followUps,
    followUpsFor,
  };
}
