import { useCallback, useState } from "react";
import { copyText } from "../lib/clipboard";
import { coreBridge } from "../lib/coreBridge";
import { captureAppScreenshot } from "../lib/gatewayConfig";
import { describeBridgeError } from "../lib/chatViewMessages";
import type { ChatMessage } from "../types";

type MessageFeedback = NonNullable<ChatMessage["feedback"]>;

interface UseChatMessageActionsOptions {
  onMessagesChange: (
    messages: ChatMessage[],
    options?: { advanceActivity?: boolean },
  ) => void;
  onRuntimeChanged: () => void | Promise<void>;
  onThreadChanged: () => void | Promise<void>;
  openGoalsTab: () => void;
  setGoalSeed: (seed: string | null) => void;
  setPromptError: (error: string | null) => void;
  threadId: string;
  threadMessages: ChatMessage[];
}

export function useChatMessageActions({
  onMessagesChange,
  onRuntimeChanged,
  onThreadChanged,
  openGoalsTab,
  setGoalSeed,
  setPromptError,
  threadId,
  threadMessages,
}: UseChatMessageActionsOptions) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const copyMessageText = useCallback(async (message: ChatMessage) => {
    if (!message.text) return;
    const ok = await copyText(message.text);
    if (!ok) return;
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId(null), 1_400);
  }, []);

  const captureScreenshot = useCallback(async () => {
    await captureAppScreenshot();
  }, []);

  const setMessageFeedback = useCallback(
    async (message: ChatMessage, feedback: MessageFeedback) => {
      if (message.role !== "assistant") return;
      const nextFeedback = message.feedback === feedback ? undefined : feedback;
      const optimisticMessages = threadMessages.map((item) =>
        item.id === message.id ? { ...item, feedback: nextFeedback } : item,
      );
      onMessagesChange(optimisticMessages);
      setPromptError(null);
      try {
        await coreBridge.setChatMessageFeedback(
          threadId,
          message.id,
          nextFeedback ?? null,
        );
        await onThreadChanged();
      } catch (error) {
        onMessagesChange(threadMessages);
        setPromptError(describeBridgeError(error));
      }
    },
    [onMessagesChange, onThreadChanged, setPromptError, threadId, threadMessages],
  );

  const saveMessageAsGoal = useCallback(
    (text?: string | null) => {
      const seed = (text ?? "").trim();
      if (!seed) return;
      setGoalSeed(seed);
      openGoalsTab();
    },
    [openGoalsTab, setGoalSeed],
  );

  const saveMessageToMemory = useCallback(
    async (message: ChatMessage) => {
      if (message.role !== "assistant" || message.savedMemoryRef) return;
      const optimisticMessages = threadMessages.map((item) =>
        item.id === message.id ? { ...item, savedMemoryRef: "pending" } : item,
      );
      onMessagesChange(optimisticMessages);
      setPromptError(null);
      try {
        await coreBridge.saveChatMessageToMemory(threadId, message.id);
        await onRuntimeChanged();
        await onThreadChanged();
      } catch (error) {
        onMessagesChange(threadMessages);
        setPromptError(describeBridgeError(error));
      }
    },
    [
      onMessagesChange,
      onRuntimeChanged,
      onThreadChanged,
      setPromptError,
      threadId,
      threadMessages,
    ],
  );

  return {
    captureScreenshot,
    copiedMessageId,
    copyMessageText,
    saveMessageAsGoal,
    saveMessageToMemory,
    setMessageFeedback,
  };
}
