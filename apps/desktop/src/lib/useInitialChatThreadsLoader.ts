import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { CoreThreadAttention } from "./coreBridge";
import { coreBridge } from "./coreBridge";
import { mapCoreChatMessage, mapCoreChatThread, starterMessages } from "./appCoreMappers";
import { selectInitialThreadFromSnapshot } from "./initialThreadSelection";
import type { ChatMessage, ChatThread } from "../types";

export function useInitialChatThreadsLoader({
  defaultThread,
  setChatThreads,
  setActiveThreadId,
  setThreadMessagesFromBackend,
  selectThreadAttention,
  applyThreadAttentionRows,
  markSelectedThreadSeen,
}: {
  defaultThread: ChatThread;
  setChatThreads: Dispatch<SetStateAction<ChatThread[]>>;
  setActiveThreadId: Dispatch<SetStateAction<string>>;
  setThreadMessagesFromBackend: (
    threadId: string,
    incomingMessages: ChatMessage[],
    options?: { force?: boolean },
  ) => void;
  selectThreadAttention: (threadId: string) => void;
  applyThreadAttentionRows: (rows: CoreThreadAttention[]) => void;
  markSelectedThreadSeen: (threadId: string) => void;
}) {
  useEffect(() => {
    let cancelled = false;

    async function loadChatThreads() {
      try {
        const snapshot = await coreBridge.chatThreads();
        if (cancelled) return;
        const mapped = snapshot.threads.map(mapCoreChatThread);
        const { desiredThreads, selectedThread } = selectInitialThreadFromSnapshot({
          mappedThreads: mapped,
          snapshotActiveThreadId: snapshot.active_thread_id,
          defaultThread,
        });
        let selectedMessages = starterMessages(selectedThread);
        let attention: CoreThreadAttention[] = [];
        try {
          const [messages, attentionRows] = await Promise.all([
            coreBridge.chatMessages(selectedThread.threadId),
            coreBridge.threadAttentions(selectedThread.workspaceId ?? undefined),
          ]);
          selectedMessages = messages.messages.map(mapCoreChatMessage);
          attention = attentionRows;
        } catch (error) {
          console.warn("active chat_messages unavailable", error);
        }
        if (cancelled) return;
        setChatThreads(desiredThreads);
        setActiveThreadId(selectedThread.threadId);
        setThreadMessagesFromBackend(selectedThread.threadId, selectedMessages);
        selectThreadAttention(selectedThread.threadId);
        applyThreadAttentionRows(attention);
        markSelectedThreadSeen(selectedThread.threadId);
      } catch (error) {
        console.warn("chat_thread_snapshot unavailable", error);
      }
    }

    void loadChatThreads();
    return () => {
      cancelled = true;
    };
  }, []);
}
