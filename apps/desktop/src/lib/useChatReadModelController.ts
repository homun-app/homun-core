import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { coreBridge } from "./coreBridge";
import {
  mapCoreChatMessage,
  mapCoreChatThread,
  updateThreadPreview,
} from "./appCoreMappers";
import {
  hasPendingLocalMessages,
  shouldPreserveLocalMessages,
} from "./chatMessagePreservation";
import { reconcileChatMessages, reconcileChatThreads } from "./uiSnapshot";
import type { CoreThreadAttention } from "./coreBridge";
import type { ChatMessage, ChatThread, ViewId } from "../types";

export function useChatReadModelController({
  activeThread,
  activeThreadId,
  chatThreads,
  threadMessages,
  defaultThread,
  pendingLocalMessageThreadIdsRef,
  busyThreadIdsRef,
  setChatThreads,
  setThreadMessages,
  setActiveThreadId,
  setActiveView,
  applyThreadAttentionRows,
  markSelectedThreadSeen,
}: {
  activeThread: ChatThread;
  activeThreadId: string;
  chatThreads: ChatThread[];
  threadMessages: Record<string, ChatMessage[]>;
  defaultThread: ChatThread;
  pendingLocalMessageThreadIdsRef: MutableRefObject<Set<string>>;
  busyThreadIdsRef: MutableRefObject<Set<string>>;
  setChatThreads: Dispatch<SetStateAction<ChatThread[]>>;
  setThreadMessages: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>;
  setActiveThreadId: Dispatch<SetStateAction<string>>;
  setActiveView: (view: ViewId) => void;
  applyThreadAttentionRows: (rows: CoreThreadAttention[]) => void;
  markSelectedThreadSeen: (threadId: string) => void;
}) {
  const activeMessages = threadMessages[activeThread.threadId] ?? [];

  function setThreadMessagesFromBackend(
    threadId: string,
    incomingMessages: ChatMessage[],
    options: { force?: boolean } = {},
  ) {
    setThreadMessages((current) => {
      const currentMessages = current[threadId];
      if (
        options.force !== true &&
        shouldPreserveLocalMessages({
          currentMessages,
          incomingMessages,
          isProtected:
            pendingLocalMessageThreadIdsRef.current.has(threadId) ||
            busyThreadIdsRef.current.has(threadId),
        })
      ) {
        return current;
      }
      pendingLocalMessageThreadIdsRef.current.delete(threadId);
      const reconciled = reconcileChatMessages(currentMessages, incomingMessages);
      if (reconciled === currentMessages) return current;
      return {
        ...current,
        [threadId]: reconciled,
      };
    });
  }

  async function handleSelectThread(threadId: string) {
    const fallback = chatThreads.find((item) => item.threadId === threadId);
    setActiveThreadId(threadId);
    markSelectedThreadSeen(threadId);
    setActiveView("chat");
    try {
      const snapshot = await coreBridge.selectChatThread(threadId);
      const mappedThreads = snapshot.threads.map(mapCoreChatThread);
      const selectedThread =
        mappedThreads.find((item) => item.threadId === threadId) ?? fallback;
      setChatThreads((current) =>
        mappedThreads.length ? reconcileChatThreads(current, mappedThreads) : current,
      );
      const attention = await coreBridge.threadAttentions(
        selectedThread?.workspaceId ?? undefined,
      );
      applyThreadAttentionRows(attention);
      markSelectedThreadSeen(threadId);
      if (!threadMessages[threadId]) {
        const messages = await coreBridge.chatMessages(threadId);
        setThreadMessagesFromBackend(
          threadId,
          messages.messages.map(mapCoreChatMessage),
        );
      }
    } catch (error) {
      console.warn("select_chat_thread unavailable", error);
    }
  }

  async function refreshThreadInBackground(
    threadId: string,
    workspaceId?: string,
    options: { forceMessages?: boolean } = {},
  ) {
    try {
      const [snapshot, messages, attention] = await Promise.all([
        coreBridge.chatThreads(workspaceId),
        coreBridge.chatMessages(threadId),
        coreBridge.threadAttentions(workspaceId),
      ]);
      const mappedThreads = snapshot.threads.map(mapCoreChatThread);
      if (
        mappedThreads.some((thread) => thread.threadId === activeThreadId) ||
        workspaceId === activeThread.workspaceId
      ) {
        setChatThreads((current) =>
          mappedThreads.length ? reconcileChatThreads(current, mappedThreads) : current,
        );
      }
      setThreadMessagesFromBackend(
        threadId,
        messages.messages.map(mapCoreChatMessage),
        { force: options.forceMessages === true },
      );
      applyThreadAttentionRows(attention);
    } catch (error) {
      console.warn("refresh_thread_in_background unavailable", error);
    }
  }

  function handleMessagesChange(
    threadId: string,
    messages: ChatMessage[],
    options: { advanceActivity?: boolean } = {},
  ) {
    if (options.advanceActivity === true) {
      pendingLocalMessageThreadIdsRef.current.delete(threadId);
    } else if (hasPendingLocalMessages(messages)) {
      pendingLocalMessageThreadIdsRef.current.add(threadId);
    }
    setThreadMessages((current) => ({
      ...current,
      [threadId]: messages,
    }));
    setChatThreads((current) =>
      current.map((thread) =>
        thread.threadId === threadId
          ? updateThreadPreview(thread, messages, options)
          : thread,
      ),
    );
  }

  async function refreshChatReadModels(preferredThreadId = activeThreadId) {
    const snapshot = await coreBridge.chatThreads();
    const mappedThreads = snapshot.threads.map(mapCoreChatThread);
    const desired = mappedThreads.length ? mappedThreads : [defaultThread];
    setChatThreads((current) => reconcileChatThreads(current, desired));
    const preferred = mappedThreads.find(
      (thread) => thread.threadId === preferredThreadId,
    );
    if (!preferred) return;
    const messages = await coreBridge.chatMessages(preferred.threadId);
    setThreadMessagesFromBackend(
      preferred.threadId,
      messages.messages.map(mapCoreChatMessage),
    );
    applyThreadAttentionRows(await coreBridge.threadAttentions());
  }

  return {
    activeMessages,
    setThreadMessagesFromBackend,
    handleSelectThread,
    refreshThreadInBackground,
    handleMessagesChange,
    refreshChatReadModels,
  };
}
