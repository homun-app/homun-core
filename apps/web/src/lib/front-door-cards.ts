/**
 * Pure selection of the front-door outcome cards for a chat transcript.
 *
 * Ogni esito del turno di ingresso ha UNA scheda, agganciata al messaggio che
 * l'ha prodotta: proposta di accordo, chiarimento, anteprima di modifica del
 * piano. Qui si decide QUALE scheda mostrare e in quale stato; il componente
 * decide come si disegna. Nessuno stato inventato: una scheda scompare solo
 * per fatti (conferma, sorpasso, risposta, versione del lavoro mossa).
 */
import type { ConversationMessage } from "@/components/builder/conversation-types";

export type FrontDoorClarifyQuestion = {
  question: string;
  choices: string[];
  multi_select?: boolean;
};

export type FrontDoorCard =
  | { kind: "agreement"; messageId: string; state: "pending" | "confirmed" }
  | { kind: "clarify"; messageId: string; questions: FrontDoorClarifyQuestion[] }
  | { kind: "plan-change"; messageId: string; summaryLines: string[] };

export type FrontDoorCardMessage = Pick<
  ConversationMessage,
  "engineMessageId" | "who" | "patchProposal" | "frontDoor" | "intakeProposalId"
>;

export type FrontDoorCardsInput = {
  messages: readonly FrontDoorCardMessage[];
  /** Ultima proposta del lavoro, come la legge l'hook dell'accordo (Fonte=motore). */
  intakeProposal: { id: string; status: string } | null;
  /** Versione attuale del lavoro: un'anteprima di patch vale solo contro di essa. */
  workVersion: number;
  /** Anteprime già applicate o annullate localmente (per id messaggio motore). */
  resolvedPatchIds?: readonly string[];
  /** Proposte chiuse con Annulla: la scheda si nasconde, il record resta. */
  dismissedProposalIds?: readonly string[];
};

/** Which outcome cards are live, keyed by the engine message that produced them. */
export function frontDoorCards(input: FrontDoorCardsInput): FrontDoorCard[] {
  const resolved = new Set(input.resolvedPatchIds ?? []);
  const dismissed = new Set(input.dismissedProposalIds ?? []);
  const cards: FrontDoorCard[] = [];
  let lastUserIndex = -1;
  input.messages.forEach((message, index) => {
    if (message.who === "you") lastUserIndex = index;
  });
  for (let index = 0; index < input.messages.length; index++) {
    const message = input.messages[index] as FrontDoorCardMessage;
    if (message.who !== "agent" || !message.engineMessageId) continue;
    const id = message.engineMessageId;
    if (
      message.intakeProposalId &&
      input.intakeProposal &&
      message.intakeProposalId === input.intakeProposal.id
    ) {
      if (input.intakeProposal.status === "pending_confirmation") {
        if (!dismissed.has(message.intakeProposalId))
          cards.push({ kind: "agreement", messageId: id, state: "pending" });
      } else if (input.intakeProposal.status === "confirmed") {
        cards.push({ kind: "agreement", messageId: id, state: "confirmed" });
      }
      continue;
    }
    const front = message.frontDoor;
    if (front?.kind === "clarification" && (front.questions?.length ?? 0) > 0) {
      // Resta aperta finché la persona non ha risposto in chat.
      if (index > lastUserIndex)
        cards.push({ kind: "clarify", messageId: id, questions: front.questions });
      continue;
    }
    const patch = message.patchProposal;
    if (patch && patch.base_version === input.workVersion && !resolved.has(id)) {
      cards.push({ kind: "plan-change", messageId: id, summaryLines: patch.summary_lines });
    }
  }
  return cards;
}
