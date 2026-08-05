import { useMemo, useRef, useState } from "react";
import type { CoreThreadAttention } from "./coreBridge";
import { coreBridge } from "./coreBridge";
import {
  createThreadAttentionState,
  hydrateThreadAttentionState,
  selectThread,
  type ThreadAttentionState,
  type ThreadAttentionStatus,
} from "./threadAttentionState";
import {
  attentionRequiredThreadIds,
  projectConversationAttention,
} from "./conversationAttention";
import { mapCoreThreadAttention } from "./appCoreMappers";
import type { ApprovelItem, ChatThread, UncertainEffectItem } from "../types";

export function useThreadAttentionController({
  initialThreadId,
  chatThreads,
  approvalItems,
  uncertainEffectItems,
  busyThreadIds,
}: {
  initialThreadId: string;
  chatThreads: ChatThread[];
  approvalItems: ApprovelItem[];
  uncertainEffectItems: UncertainEffectItem[];
  busyThreadIds: Set<string>;
}): {
  threadAttention: ThreadAttentionState;
  pendingAttentionThreadIds: Set<string>;
  attentionByThread: Record<string, ThreadAttentionStatus>;
  applyThreadAttentionRows: (rows: CoreThreadAttention[]) => void;
  markSelectedThreadSeen: (threadId: string) => void;
  selectThreadAttention: (threadId: string) => ThreadAttentionState;
} {
  const [threadAttention, setThreadAttention] = useState<ThreadAttentionState>(() =>
    createThreadAttentionState(initialThreadId),
  );
  const threadAttentionRef = useRef(threadAttention);

  function applyThreadAttentionRows(rows: CoreThreadAttention[]) {
    const current = threadAttentionRef.current;
    const next = hydrateThreadAttentionState(
      current,
      rows.map(mapCoreThreadAttention),
    );
    threadAttentionRef.current = next;
    setThreadAttention(next);
    const selectedThreadId = next.selectedThreadId;
    const seenTerminalEventId = next.seenTerminalEventIds[selectedThreadId] ?? 0;
    if (seenTerminalEventId > (current.seenTerminalEventIds[selectedThreadId] ?? 0)) {
      void coreBridge
        .markThreadSeen(selectedThreadId, seenTerminalEventId)
        .then((row) => applyThreadAttentionRows([row]))
        .catch((error) => console.warn("mark_thread_seen unavailable", error));
    }
  }

  function selectThreadAttention(threadId: string) {
    const next = selectThread(threadAttentionRef.current, threadId);
    threadAttentionRef.current = next;
    setThreadAttention(next);
    return next;
  }

  function markSelectedThreadSeen(threadId: string) {
    const current = threadAttentionRef.current;
    const next = selectThreadAttention(threadId);
    const terminalEventId = next.seenTerminalEventIds[threadId] ?? 0;
    if (terminalEventId > (current.seenTerminalEventIds[threadId] ?? 0)) {
      void coreBridge
        .markThreadSeen(threadId, terminalEventId)
        .then((row) => applyThreadAttentionRows([row]))
        .catch((error) => console.warn("mark_thread_seen unavailable", error));
    }
  }

  const pendingAttentionThreadIds = useMemo(
    () => attentionRequiredThreadIds(chatThreads, approvalItems, uncertainEffectItems),
    [approvalItems, chatThreads, uncertainEffectItems],
  );
  const attentionByThread = useMemo(
    () =>
      projectConversationAttention(
        threadAttention.byThread,
        busyThreadIds,
        pendingAttentionThreadIds,
      ),
    [busyThreadIds, pendingAttentionThreadIds, threadAttention.byThread],
  );

  return {
    threadAttention,
    pendingAttentionThreadIds,
    attentionByThread,
    applyThreadAttentionRows,
    markSelectedThreadSeen,
    selectThreadAttention,
  };
}
