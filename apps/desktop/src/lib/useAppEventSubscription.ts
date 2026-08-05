import { useEffect, useRef } from "react";
import type { AppEvent } from "./coreBridge";
import { wsSubscription } from "./wsSubscription";
import { notificationPermission, showSystemNotification } from "./systemNotifications";

export interface IncomingBackgroundTurn {
  turnId: string;
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export function useAppEventSubscription({
  activeThreadId,
  systemNotifEnabled,
  labels,
  onSelectThread,
  refreshThreadInBackground,
  setIncomingBackgroundTurn,
  bumpIslandRefreshNonce,
}: {
  activeThreadId: string;
  systemNotifEnabled: boolean;
  labels: {
    newActivity: string;
    scheduledReady: string;
    newMessage: string;
  };
  onSelectThread: (threadId: string) => void | Promise<void>;
  refreshThreadInBackground: (
    threadId: string,
    workspaceId?: string,
    options?: { forceMessages?: boolean },
  ) => void | Promise<void>;
  setIncomingBackgroundTurn: (turn: IncomingBackgroundTurn) => void;
  bumpIslandRefreshNonce: () => void;
}) {
  const appEventHandlerRef = useRef<(event: AppEvent) => void>(() => {});
  appEventHandlerRef.current = (event: AppEvent) => {
    if (!event.thread_id) return;
    // The "homun" thread is retired as a proactive surface (its curiosities/onboarding
    // now flow as proactivity cards) and has no nav entry to update.
    if (event.thread_id === "homun") {
      return;
    }
    const eventThreadId = event.thread_id;
    const isVisibleTurn = event.type === "thread.turn_started";
    const isThreadCreated = event.type === "thread.upserted";
    if (isVisibleTurn || isThreadCreated) {
      if (
        systemNotifEnabled &&
        document.hidden &&
        notificationPermission() === "granted"
      ) {
        const threadId = event.thread_id;
        void showSystemNotification({
          title: event.title || labels.newActivity,
          body:
            event.channel === "scheduled"
              ? labels.scheduledReady
              : labels.newMessage,
          tag: threadId,
          onClick: () => void onSelectThread(threadId),
        });
      }
      if (
        isVisibleTurn &&
        eventThreadId === activeThreadId &&
        event.turn_id &&
        event.user_message_id &&
        event.assistant_message_id
      ) {
        setIncomingBackgroundTurn({
          turnId: event.turn_id,
          threadId: eventThreadId,
          userMessageId: event.user_message_id,
          assistantMessageId: event.assistant_message_id,
        });
      }
      void refreshThreadInBackground(eventThreadId, event.workspace, {
        forceMessages: isVisibleTurn,
      });
    } else if (event.type === "thread.updated") {
      if (event.workspace) {
        void refreshThreadInBackground(eventThreadId, event.workspace);
      } else {
        void refreshThreadInBackground(eventThreadId);
      }
      if (eventThreadId === activeThreadId) {
        bumpIslandRefreshNonce();
      }
    }
  };

  useEffect(() => {
    wsSubscription.connect();
    const unsub = wsSubscription.subscribe((msg) => {
      if (msg.type === "app.event") {
        const event = msg.event as Record<string, unknown>;
        appEventHandlerRef.current(
          event as unknown as Parameters<typeof appEventHandlerRef.current>[0],
        );
      }
    });
    return () => {
      // The WebSocket is a process-lifetime singleton; React unmount only removes
      // this component's listener.
      unsub();
    };
  }, []);
}
