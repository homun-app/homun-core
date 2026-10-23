/**
 * Le schede degli esiti del turno di ingresso, DENTRO la trascrizione della
 * chat del motore: ogni scheda sta sotto il messaggio che l'ha prodotta
 * (slot AssistantMessageExtra del thread assistant-ui), senza ricaricare.
 *
 * Un solo componente per tipo: EngineIntakeCoordinatorCard (accordo),
 * EngineFrontDoorClarifyCard (chiarimento), WorkPatchPreviewCard (piano).
 * La selezione è il modulo puro `frontDoorCards`; qui si collegano le azioni
 * reali (conferma, messaggio in chat, patch) e gli errori restano nella
 * scheda, mai nel piè di pagina.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";

import {
  frontDoorCards,
  type FrontDoorCard,
  type FrontDoorPatchPreview,
} from "@/lib/front-door-cards";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import type { WorkExecutionState } from "@/hooks/useWorkExecution";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { EngineIntakeCoordinatorCard } from "../EngineIntakeCoordinatorCard";
import { WorkPatchPreviewCard } from "../WorkPatchPreviewCard";
import { EngineFrontDoorClarifyCard } from "./EngineFrontDoorClarifyCard";
import { EngineWorkExecutionCard } from "./EngineWorkExecutionCard";

export type FrontDoorCardsSlots = {
  /** Schede vive per id del nodo del thread (modulo puro). */
  cards: Map<string, FrontDoorCard>;
  intake: WorkIntakeState;
  /** Esecuzione del lavoro confermato: la scheda sta sotto l'accordo. */
  execution: WorkExecutionState;
  busy: boolean;
  onSendMessage: (text: string) => void;
  onDismissProposal: (proposalId: string) => void;
  onConfirmPatch: (patch: FrontDoorPatchPreview) => Promise<void>;
  onDismissPatch: (messageId: string) => void;
  onInspectAgent?: ((agentIdOrName: string) => void) | undefined;
};

const FrontDoorCardsContext = createContext<FrontDoorCardsSlots | null>(null);

export function FrontDoorCardsProvider({
  slots,
  children,
}: {
  slots: FrontDoorCardsSlots | null;
  children: ReactNode;
}) {
  return <FrontDoorCardsContext.Provider value={slots}>{children}</FrontDoorCardsContext.Provider>;
}

/** Slot per-messaggio del thread: disegna la scheda dell'esito di quel turno. */
export function EngineFrontDoorMessageExtra() {
  const slots = useContext(FrontDoorCardsContext);
  const messageId = useAuiState((s) => s.message.id);
  const [patchError, setPatchError] = useState<unknown>(null);
  const card = slots?.cards.get(messageId);
  if (!slots || !card) return null;
  if (card.kind === "agreement") {
    const proposal = slots.intake.proposal;
    if (!proposal) return null;
    // «Conferma accordo e avvia»: conferma, poi il motore avvia nella modalità
    // scelta (o prepara il via libera). La UI non sceglie mai l'esecutore.
    const intake: WorkIntakeState = {
      ...slots.intake,
      confirm: async () => {
        const confirmed = await slots.intake.confirm();
        if (confirmed?.status === "confirmed") await slots.execution.start();
        return confirmed;
      },
    };
    return (
      <>
        <EngineIntakeCoordinatorCard
          proposal={proposal}
          intake={intake}
          onInspectAgent={slots.onInspectAgent}
          onSendMessage={slots.onSendMessage}
          onDismiss={
            card.state === "pending" && proposal.status === "pending_confirmation"
              ? () => slots.onDismissProposal(proposal.id)
              : undefined
          }
        />
        {proposal.status === "confirmed" && <EngineWorkExecutionCard state={slots.execution} />}
      </>
    );
  }
  if (card.kind === "clarify") {
    return (
      <EngineFrontDoorClarifyCard
        questions={card.questions}
        disabled={slots.busy}
        onSendMessage={slots.onSendMessage}
      />
    );
  }
  return (
    <div className="cw-front-door-patch">
      <WorkPatchPreviewCard
        summaryLines={card.summaryLines}
        busy={slots.busy}
        onConfirm={() => {
          setPatchError(null);
          void slots.onConfirmPatch(card.patch).catch((cause: unknown) => setPatchError(cause));
        }}
        onCancel={() => slots.onDismissPatch(card.id)}
      />
      <HomunErrorNotice error={patchError} />
    </div>
  );
}
