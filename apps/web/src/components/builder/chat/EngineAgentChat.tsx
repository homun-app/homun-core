/** Stage chat del motore: Welcome + thread assistant-ui + composer originale.

    Il composer è `StudioChatInput` (modello, autonomia, menzioni, allegati) e
    l'invio passa dalla pipeline engine esistente (`handleEngineSend`), non da
    una strada parallela. Il thread renderizza trascrizione e streaming SSE. */
import { X } from "lucide-react";

import { useConversationEventStream } from "@/hooks/useConversationEventStream";
import type { AutonomyLevel } from "../conversation-preferences";
import type { ConversationScenario } from "../conversation-scenarios";
import type { SpaceData } from "../ConversationSpace";
import { ConversationWorkspaceWelcome } from "../ConversationWorkspaceWelcome";
import { StudioChatInput, type ChatReference } from "../StudioChatInput";

import { AgentChat } from "./AgentChat";
import { useChatStream } from "./useChatStream";

type Props = {
  conversationId: string | undefined;
  activeWorkId: string | null;
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
  assignee: string;
  scenarios: ConversationScenario[];
  spaceData: SpaceData;
  onCreateExample: (index: number) => void;
};

export function EngineAgentChat({
  conversationId,
  activeWorkId,
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
  assignee,
  scenarios,
  spaceData,
  onCreateExample,
}: Props) {
  const { messages, isRunning, historyLoading: streamLoading, noteUserSent } =
    useChatStream(conversationId);
  // i dati del motore (lavori, pannelli) si rinfrescano quando la chat scrive
  useConversationEventStream(conversationId ?? null, {
    ...(onRefreshEngine ? { onNewMessage: () => void onRefreshEngine() } : {}),
  });

  const showThread = Boolean(conversationId) || messages.length > 0;
  const loading = conversationId ? streamLoading || historyLoading : false;

  function handleSend(text: string, files: File[]) {
    noteUserSent(text);
    onSend(text, files);
  }

  return (
    <div className="cw-stage">
      <section className="cw-conversation">
        <div className="cw-history">
          {showThread ? (
            <AgentChat messages={messages} isRunning={isRunning} />
          ) : (
            <ConversationWorkspaceWelcome
              assignee={assignee}
              scenarios={scenarios}
              spaceData={spaceData}
              onCreateExample={onCreateExample}
              engineMode
              onRefreshEngine={onRefreshEngine}
              onOpenSpace={onOpenSpace}
            />
          )}
        </div>
        <div className="cw-composer">
          {assignee && (
            <p className="cw-hint">
              Nuovo incarico per <strong>{assignee}</strong> · descrivi il risultato che vuoi
              ottenere.
            </p>
          )}
          <StudioChatInput
            key={activeWorkId ?? "new"}
            label="Messaggio alla squadra"
            disabled={Boolean(conversationId) && historyLoading}
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
          {(engineBusy || isRunning) && onCancelInFlight && (
            <p className="cw-hint cw-engine-busy" role="status">
              Homun sta aspettando la risposta del modello: la conversazione mostra i passaggi e il
              tempo trascorso.{" "}
              <button type="button" className="cs-link" onClick={onCancelInFlight}>
                Annulla
              </button>
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
