import { useEffect, useRef } from "react";
import { notificationPermission, showSystemNotification } from "./systemNotifications";
import type { ChatThread } from "../types";

export function useThreadAttentionNotifications({
  chatThreads,
  pendingAttentionThreadIds,
  systemNotifEnabled,
  labels,
  onSelectThread,
}: {
  chatThreads: ChatThread[];
  pendingAttentionThreadIds: Set<string>;
  systemNotifEnabled: boolean;
  labels: {
    requiresAttention: string;
    openConversation: string;
  };
  onSelectThread: (threadId: string) => void | Promise<void>;
}) {
  const notifiedAttentionThreadIdsRef = useRef<Set<string> | null>(null);
  const onSelectThreadRef = useRef(onSelectThread);
  onSelectThreadRef.current = onSelectThread;

  useEffect(() => {
    const previous = notifiedAttentionThreadIdsRef.current;
    notifiedAttentionThreadIdsRef.current = new Set(pendingAttentionThreadIds);
    if (previous === null) return;
    if (
      !systemNotifEnabled ||
      !document.hidden ||
      notificationPermission() !== "granted"
    ) {
      return;
    }
    for (const threadId of pendingAttentionThreadIds) {
      if (previous.has(threadId)) continue;
      const owner = chatThreads.find((thread) => thread.threadId === threadId);
      void showSystemNotification({
        title: labels.requiresAttention,
        body: owner?.title ?? labels.openConversation,
        tag: `attention:${threadId}`,
        onClick: () => void onSelectThreadRef.current(threadId),
      });
    }
  }, [
    chatThreads,
    labels.openConversation,
    labels.requiresAttention,
    pendingAttentionThreadIds,
    systemNotifEnabled,
  ]);
}
