import { useCallback, useState } from "react";
import type { ChatAttachmentInput } from "../lib/coreBridge";
import type { ChatAttachment, ChatMessage } from "../types";

type SubmitEditedPrompt = (
  prompt: string,
  attachments: ChatAttachmentInput[],
  visibleAttachments?: ChatAttachment[],
  visibleText?: string,
  model?: string,
  images?: string[],
  baseMessages?: ChatMessage[],
  mode?: string,
  branchFromId?: string,
) => void | Promise<void>;

interface UseChatMessageEditingOptions {
  promptSubmitting: boolean;
  setOptimisticMessages: (messages: ChatMessage[] | null) => void;
  submitEditedPrompt: SubmitEditedPrompt;
  threadMessages: ChatMessage[];
}

export function useChatMessageEditing({
  promptSubmitting,
  setOptimisticMessages,
  submitEditedPrompt,
  threadMessages,
}: UseChatMessageEditingOptions) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  const cancelEditMessage = useCallback(() => {
    setEditingMessageId(null);
    setEditingText("");
  }, []);

  const startEditMessage = useCallback(
    (message: ChatMessage) => {
      if (promptSubmitting) return;
      setEditingMessageId(message.id);
      setEditingText(message.text);
    },
    [promptSubmitting],
  );

  const saveEditedMessage = useCallback(() => {
    const id = editingMessageId;
    const text = editingText.trim();
    if (!id || !text || promptSubmitting) return;
    const index = threadMessages.findIndex((message) => message.id === id);
    if (index < 0) {
      cancelEditMessage();
      return;
    }
    const base = threadMessages.slice(0, index);
    const original = threadMessages[index];
    setEditingMessageId(null);
    setEditingText("");
    // Edited user messages create a sibling branch. Show the context before the
    // edited turn until the persisted branch replaces this optimistic projection.
    setOptimisticMessages(base);
    void submitEditedPrompt(
      text,
      [],
      original.attachments ?? [],
      undefined,
      undefined,
      undefined,
      base,
      undefined,
      id,
    );
  }, [
    cancelEditMessage,
    editingMessageId,
    editingText,
    promptSubmitting,
    setOptimisticMessages,
    submitEditedPrompt,
    threadMessages,
  ]);

  return {
    cancelEditMessage,
    editingMessageId,
    editingText,
    saveEditedMessage,
    setEditingText,
    startEditMessage,
  };
}
