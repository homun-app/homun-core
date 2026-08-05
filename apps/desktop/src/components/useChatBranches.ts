import { useCallback, useEffect, useState } from "react";
import { coreBridge, type CoreBranchPoint } from "../lib/coreBridge";
import { describeBridgeError } from "../lib/chatViewMessages";
import type { ChatMessage } from "../types";

interface UseChatBranchesOptions {
  branchLabelPrompt: string;
  isMountedRef: { current: boolean };
  messages: ChatMessage[];
  onThreadChanged: () => void | Promise<void>;
  promptSubmitting: boolean;
  setOptimisticMessages: (messages: ChatMessage[] | null) => void;
  setPromptError: (message: string) => void;
  streamingAssistantId: string | null;
  threadId: string;
}

export function useChatBranches({
  branchLabelPrompt,
  isMountedRef,
  messages,
  onThreadChanged,
  promptSubmitting,
  setOptimisticMessages,
  setPromptError,
  streamingAssistantId,
  threadId,
}: UseChatBranchesOptions) {
  const [branches, setBranches] = useState<CoreBranchPoint[]>([]);
  const [branchBusy, setBranchBusy] = useState(false);

  const refreshBranches = useCallback(async () => {
    try {
      const next = await coreBridge.chatBranches(threadId);
      if (isMountedRef.current) setBranches(next);
    } catch {
      /* switcher is best-effort; ignore */
    }
  }, [isMountedRef, threadId]);

  useEffect(() => {
    void refreshBranches();
  }, [refreshBranches, messages]);

  const switchBranch = useCallback(
    async (point: CoreBranchPoint, direction: number) => {
      if (branchBusy || promptSubmitting || streamingAssistantId) return;
      const index = point.active_index + direction;
      if (index < 0 || index >= point.options.length) return;
      setBranchBusy(true);
      try {
        await coreBridge.setActiveLeaf(threadId, point.options[index].leaf_id);
        setOptimisticMessages(null);
        await onThreadChanged();
        await refreshBranches();
      } catch (error) {
        setPromptError(describeBridgeError(error));
      } finally {
        setBranchBusy(false);
      }
    },
    [
      branchBusy,
      onThreadChanged,
      promptSubmitting,
      refreshBranches,
      setOptimisticMessages,
      setPromptError,
      streamingAssistantId,
      threadId,
    ],
  );

  const renameBranch = useCallback(
    async (childId: string, current: string | null) => {
      const input = window.prompt(branchLabelPrompt, current ?? "");
      if (input === null) return;
      const label = input.trim();
      try {
        setBranches(await coreBridge.setBranchLabel(threadId, childId, label || null));
      } catch (error) {
        setPromptError(describeBridgeError(error));
      }
    },
    [branchLabelPrompt, setPromptError, threadId],
  );

  return {
    branchBusy,
    branches,
    refreshBranches,
    renameBranch,
    switchBranch,
  };
}
