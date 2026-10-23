/** Stage chat del motore: Welcome + thread assistant-ui + composer originale.

    Il composer è `StudioChatInput` (modello, autonomia, menzioni, allegati) e
    l'invio passa dalla pipeline engine esistente (`handleEngineSend`), non da
    una strada parallela. Il thread renderizza trascrizione e streaming SSE.
    Sotto ogni messaggio assistente può comparire la scheda dell'esito del
    turno di ingresso (accordo, chiarimento, modifica del piano): la stessa
    scheda ovunque, selezionata dal modulo puro `frontDoorCards`.
    Gli stati del motore vivono qui, nel thread e sopra il campo di scrittura:
    mai tra i messaggi del runtime. */
import { useMemo, useState } from "react";
import { X } from "lucide-react";

import { useConversationEventStream } from "@/hooks/useConversationEventStream";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import { useTransientResolved } from "@/hooks/useTransientResolved";
import type { AutonomyLevel } from "../conversation-preferences";
import type { Work } from "../conversation-types";
import { ConversationBrowserPip } from "../ConversationBrowserPip";
import type { ConversationScenario } from "../conversation-scenarios";
import type { SpaceData } from "../ConversationSpace";
import { ConversationWorkspaceWelcome } from "../ConversationWorkspaceWelcome";
import { StudioChatInput, type ChatReference } from "../StudioChatInput";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import type { WorkExecutionState } from "@/hooks/useWorkExecution";
import type { FrontDoorPatchPreview } from "@/lib/front-door-cards";
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
import { EngineFrontDoorMessageExtra, FrontDoorCardsProvider } from "./EngineFrontDoorCards";
import { frontDoorCardMap } from "@/lib/front-door-cards";
import { useChatStream } from "./useChatStream";

type FrontDoorSlots = {
  intake: WorkIntakeState;
  execution: WorkExecutionState;
  work: Work | undefined;
  /** Applica un'anteprima di patch (Conferma della scheda di modifica piano). */
  onConfirmPatch: (patch: FrontDoorPatchPreview) => Promise<void>;
};

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
  /** Schede degli esiti del turno di ingresso (accordo/chiarimento/piano). */
  frontDoor: FrontDoorSlots | undefined;
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
  frontDoor,
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

  // Chiusure locali delle schede: la proposta Annullata non si rimostra, una
  // patch applicata o annullata resta chiusa finché la versione non cambia.
  const [dismissedProposalIds, setDismissedProposalIds] = useState<string[]>([]);
  const [resolvedPatchIds, setResolvedPatchIds] = useState<string[]>([]);

  const frontDoorCardsMap = useMemo(() => {
    if (!frontDoor) return new Map();
    return frontDoorCardMap({
      messages,
      intakeProposal: frontDoor.intake.proposal,
      workVersion: frontDoor.work?.revision ?? 0,
      resolvedPatchIds,
      dismissedProposalIds,
    });
  }, [frontDoor, messages, resolvedPatchIds, dismissedProposalIds]);

  function handleSend(text: string, files: File[]) {
    noteUserSent(text);
    onSend(text, files);
  }

  const frontDoorSlots = frontDoor
    ? {
        cards: frontDoorCardsMap,
        intake: frontDoor.intake,
        execution: frontDoor.execution,
        busy: engineBusy || isRunning,
        onSendMessage: (text: string) => handleSend(text, []),
        onDismissProposal: (proposalId: string) =>
          setDismissedProposalIds((current) => [...current, proposalId]),
        onConfirmPatch: frontDoor.onConfirmPatch,
        onDismissPatch: (messageId: string) =>
          setResolvedPatchIds((current) => [...current, messageId]),
      }
    : null;

  const showThread = Boolean(conversationId) || messages.length > 0;
  const loading = conversationId ? streamLoading || historyLoading : false;

  const status = chatStatusLayout(statusNotices, conversationId ?? null);
  const unreachable = status.aboveComposer.some((item) => item.kind === "engine-unreachable");
  // L'esito «Connessione ripristinata.» celebra una caduta VISTA in questa
  // sessione: all'avvio a motore freddo la connessione non è mai caduta, stava
  // solo arrivando — niente esito finché non è stata su almeno una volta.
  const { everConnected } = useEngineStatus();
  const connectionRestored = useTransientResolved(unreachable && everConnected);
  function handleStatusAction(action: ChatStatusActionId) {
    if (action === "refresh") void onRefreshEngine?.();
    else if (action === "open-models") onOpenModels?.();
  }

  return (
    <div className="cw-stage">
      <section className="cw-conversation">
        <div className="cw-history">
          {showThread ? (
            <>
              <ConversationBrowserPip
                conversationId={conversationId}
                runActive={agentStream.runActive}
              />
              {/* gli avvisi vivono DENTRO l'area scorrevole del thread: si
                  legono dove si leggono i messaggi, non oltre il suo fondo */}
              <FrontDoorCardsProvider slots={frontDoorSlots}>
                <AgentChat
                  messages={messages}
                  isRunning={isRunning || engineBusy}
                  threadTop={<ThreadTopStatusNotices notices={status.threadTop} />}
                  threadEnd={<ThreadEndStatusNotices notices={status.threadEnd} />}
                  assistantMessageExtra={frontDoorSlots ? EngineFrontDoorMessageExtra : undefined}
                />
              </FrontDoorCardsProvider>
            </>
          ) : (
            <>
              <ThreadTopStatusNotices notices={status.threadTop} />
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
            </>
          )}
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
