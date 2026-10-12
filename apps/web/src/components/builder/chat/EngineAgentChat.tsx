/** Stage chat del motore: Welcome + thread assistant-ui + composer originale.

    Il composer è `StudioChatInput` (modello, autonomia, menzioni, allegati) e
    l'invio passa dalla pipeline engine esistente (`handleEngineSend`), non da
    una strada parallela. Il thread renderizza trascrizione e streaming SSE.
    Gli stati del motore vivono qui, nel thread e sopra il campo di scrittura:
    mai tra i messaggi del runtime. */
import { X } from "lucide-react";

import { useConversationEventStream } from "@/hooks/useConversationEventStream";
import { useTransientResolved } from "@/hooks/useTransientResolved";
import type { AutonomyLevel } from "../conversation-preferences";
import { ConversationBrowserPip } from "../ConversationBrowserPip";
import type { ConversationScenario } from "../conversation-scenarios";
import type { SpaceData } from "../ConversationSpace";
import { ConversationWorkspaceWelcome } from "../ConversationWorkspaceWelcome";
import { StudioChatInput, type ChatReference } from "../StudioChatInput";
import {
  chatStatusLayout,
  type ChatStatusActionId,
  type ChatStatusNotice,
} from "@/lib/chat-status-notices";

import { AgentChat } from "./AgentChat";
import {
  ComposerStatusNotices,
  ThreadEndStatusNotices,
  ThreadTopStatusNotices,
} from "./ChatStatusNotices";
import { useChatStream } from "./useChatStream";

type Props = {
  newChatProject?: { id: string; name: string } | null | undefined;
  conversationId: string | undefined;
  activeWorkId: string | null;
  /** Stati del client già tradotti in avvisi dal modulo puro; il thread li colloca. */
  statusNotices: ChatStatusNotice[];
  onSend: (text: string, attachments: File[]) => void;
  notice: string;
  onClearNotice: () => void;
  engineBusy: boolean;
  onCancelInFlight: (() => void) | undefined;
  historyLoading: boolean;
  autonomyLevel: AutonomyLevel | undefined;
  onAutonomyLevelChange: ((level: AutonomyLevel) => void) | undefined;
  modelConnectionId: string | undefined;
  onModelConnectionIdChange: ((connectionId: string) => void) | undefined;
  references: ChatReference[];
  onRefreshEngine: (() => Promise<void>) | undefined;
  onOpenSpace:
    | ((space: "Progetti" | "Squadra" | "Materiali", initial?: string, selected?: string) => void)
    | undefined;
  onOpenModels?: (() => void) | undefined;
  assignee: string;
  scenarios: ConversationScenario[];
  spaceData: SpaceData;
  onCreateExample: (index: number) => void;
};

export function EngineAgentChat({
  newChatProject,
  conversationId,
  activeWorkId,
  statusNotices,
  onSend,
  notice,
  onClearNotice,
  engineBusy,
  onCancelInFlight,
  historyLoading,
  autonomyLevel,
  onAutonomyLevelChange,
  modelConnectionId,
  onModelConnectionIdChange,
  references,
  onRefreshEngine,
  onOpenSpace,
  onOpenModels,
  assignee,
  scenarios,
  spaceData,
  onCreateExample,
}: Props) {
  const {
    messages,
    isRunning,
    historyLoading: streamLoading,
    noteUserSent,
  } = useChatStream(conversationId);
  // i dati del motore (lavori, pannelli) si rinfrescano quando la chat scrive
  const agentStream = useConversationEventStream(conversationId ?? null, {
    ...(onRefreshEngine ? { onNewMessage: () => void onRefreshEngine() } : {}),
  });

  const showThread = Boolean(conversationId) || messages.length > 0;
  const loading = conversationId ? streamLoading || historyLoading : false;

  const status = chatStatusLayout(statusNotices, conversationId ?? null);
  const unreachable = status.aboveComposer.some((item) => item.kind === "engine-unreachable");
  // alla risoluzione un esito breve, poi più nulla: senza tracce nello storico
  const connectionRestored = useTransientResolved(unreachable);
  function handleStatusAction(action: ChatStatusActionId) {
    if (action === "refresh") void onRefreshEngine?.();
    else if (action === "open-models") onOpenModels?.();
  }

  function handleSend(text: string, files: File[]) {
    noteUserSent(text);
    onSend(text, files);
  }

  return (
    <div className="cw-stage">
      <section className="cw-conversation">
        <div className="cw-history">
          <ThreadTopStatusNotices notices={status.threadTop} />
          {showThread ? (
            <>
              <ConversationBrowserPip
                conversationId={conversationId}
                runActive={agentStream.runActive}
              />
              <AgentChat messages={messages} isRunning={isRunning || engineBusy} />
            </>
          ) : (
            <ConversationWorkspaceWelcome
              assignee={assignee}
              scenarios={scenarios}
              spaceData={spaceData}
              onCreateExample={onCreateExample}
              engineMode
              onRefreshEngine={onRefreshEngine}
              onOpenSpace={onOpenSpace}
              onOpenModels={onOpenModels}
              newChatProject={newChatProject}
            />
          )}
          <ThreadEndStatusNotices notices={status.threadEnd} />
        </div>
        <div className="cw-composer">
          <ComposerStatusNotices
            notices={status.aboveComposer}
            resolved={connectionRestored}
            busy={engineBusy}
            onAction={handleStatusAction}
          />
          {assignee && (
            <p className="cw-hint">
              Nuovo incarico per <strong>{assignee}</strong> · descrivi il risultato che vuoi
              ottenere.
            </p>
          )}
          <StudioChatInput
            key={activeWorkId ?? "new"}
            label="Messaggio alla squadra"
            disabled={unreachable || (Boolean(conversationId) && historyLoading)}
            engineBusy={isRunning || engineBusy}
            onCancel={onCancelInFlight}
            onSend={handleSend}
            references={references}
            autonomyLevel={autonomyLevel}
            onAutonomyLevelChange={onAutonomyLevelChange}
            modelConnectionId={modelConnectionId}
            onModelConnectionIdChange={onModelConnectionIdChange}
          />
          {loading && messages.length === 0 && (
            <p className="cw-hint" role="status">
              Caricamento conversazione…
            </p>
          )}
          {notice && (
            <p className="cw-notice" role="status">
              {notice}
              <button aria-label="Chiudi avviso" onClick={onClearNotice}>
                <X size={14} />
              </button>
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
