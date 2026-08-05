import type { Dispatch, SetStateAction } from "react";
import {
  coreBridge,
  type CoreChatThreadSnapshot,
} from "./coreBridge";
import {
  mapCoreChatMessage,
  mapCoreChatThread,
} from "./appCoreMappers";
import { projectThreadSnapshotSelection } from "./threadSnapshotProjection";
import { reconcileChatThreads } from "./uiSnapshot";
import { sidebarWorkspaceIsActive } from "./sidebarFilterState";
import type { ChatMessage, ChatThread } from "../types";

export function useChatThreadMutations({
  activeThreadId,
  activeWorkspaceId,
  chatThreads,
  threadMessages,
  defaultThread,
  personalWorkspaceId,
  setChatThreads,
  setActiveThreadId,
  setThreadMessages,
}: {
  activeThreadId: string;
  activeWorkspaceId?: string;
  chatThreads: ChatThread[];
  threadMessages: Record<string, ChatMessage[]>;
  defaultThread: ChatThread;
  personalWorkspaceId: string;
  setChatThreads: Dispatch<SetStateAction<ChatThread[]>>;
  setActiveThreadId: Dispatch<SetStateAction<string>>;
  setThreadMessages: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>;
}) {
  async function applyThreadSnapshot(snapshot: CoreChatThreadSnapshot) {
    const mappedThreads = snapshot.threads.map(mapCoreChatThread);
    const selection = projectThreadSnapshotSelection({
      mappedThreads,
      activeThreadId,
      snapshotActiveThreadId: snapshot.active_thread_id,
      defaultThread,
    });
    setChatThreads((current) => reconcileChatThreads(current, selection.desiredThreads));
    if (!selection.preservedThread) {
      const selectedThread = selection.selectedThread;
      setActiveThreadId(selectedThread.threadId);
    }
    if (!threadMessages[selection.selectedThread.threadId]) {
      try {
        const messages = await coreBridge.chatMessages(selection.selectedThread.threadId);
        setThreadMessages((current) => ({
          ...current,
          [selection.selectedThread.threadId]: messages.messages.map(mapCoreChatMessage),
        }));
      } catch (error) {
        console.warn("chat_messages unavailable after thread action", error);
      }
    }
  }

  async function handleSetChatThreadPinned(threadId: string, pinned: boolean) {
    try {
      await applyThreadSnapshot(await coreBridge.setChatThreadPinned(threadId, pinned));
    } catch (error) {
      setChatThreads((current) =>
        [...current]
          .map((thread) =>
            thread.threadId === threadId ? { ...thread, pinned } : thread,
          )
          .sort((left, right) => Number(right.pinned) - Number(left.pinned)),
      );
      console.warn("chat_thread_set_pinned unavailable", error);
    }
  }

  async function handleRenameChatThread(threadId: string, title: string) {
    // Optimistic: rename in place immediately; the next load reconciles if persistence fails.
    setChatThreads((current) =>
      current.map((thread) => (thread.threadId === threadId ? { ...thread, title } : thread)),
    );
    try {
      await coreBridge.renameChatThread(threadId, title);
    } catch (error) {
      console.warn("chat_thread_rename unavailable", error);
    }
  }

  async function handleArchiveChatThread(threadId: string) {
    try {
      await applyThreadSnapshot(await coreBridge.archiveChatThread(threadId));
    } catch (error) {
      const nextThreads = chatThreads.map((thread) =>
        thread.threadId === threadId
          ? { ...thread, status: "archived" as const, pinned: false }
          : thread,
      );
      setChatThreads(nextThreads);
      if (activeThreadId === threadId) {
        const nextThread = nextThreads.find((thread) => thread.status === "active");
        if (nextThread) {
          setActiveThreadId(nextThread.threadId);
        }
      }
      console.warn("chat_thread_archive unavailable", error);
    }
  }

  async function handleUnarchiveChatThread(threadId: string, workspaceId: string) {
    const ownerIsActive = sidebarWorkspaceIsActive(
      workspaceId,
      activeWorkspaceId,
      personalWorkspaceId,
    );
    try {
      const snapshot = await coreBridge.unarchiveChatThread(threadId);
      if (ownerIsActive) {
        await applyThreadSnapshot(snapshot);
      }
      return {
        threads: snapshot.threads.map(mapCoreChatThread),
        appliedToActive: ownerIsActive,
      };
    } catch (error) {
      if (ownerIsActive) {
        setChatThreads((current) =>
          current.map((thread) =>
            thread.threadId === threadId
              ? { ...thread, status: "active" as const }
              : thread,
          ),
        );
        setActiveThreadId(threadId);
      }
      console.warn("chat_thread_unarchive unavailable", error);
      return { threads: null, appliedToActive: ownerIsActive };
    }
  }

  async function handleDeleteChatThread(threadId: string) {
    // Optimistic: drop it from the list + messages immediately, then persist.
    setChatThreads((current) => current.filter((thread) => thread.threadId !== threadId));
    setThreadMessages((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    if (activeThreadId === threadId) {
      const nextThread = chatThreads.find((thread) => thread.threadId !== threadId);
      if (nextThread) {
        setActiveThreadId(nextThread.threadId);
      }
    }
    try {
      await coreBridge.deleteChatThread(threadId);
    } catch (error) {
      console.warn("chat_thread_delete unavailable", error);
    }
  }

  return {
    handleSetChatThreadPinned,
    handleRenameChatThread,
    handleArchiveChatThread,
    handleUnarchiveChatThread,
    handleDeleteChatThread,
  };
}
