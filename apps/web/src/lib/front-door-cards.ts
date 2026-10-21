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

export type FrontDoorPatchPreview = NonNullable<ConversationMessage["patchProposal"]>;

export type FrontDoorCard =
  | { kind: "agreement"; id: string; state: "pending" | "confirmed" }
  | { kind: "clarify"; id: string; questions: FrontDoorClarifyQuestion[] }
  | { kind: "plan-change"; id: string; summaryLines: string[]; patch: FrontDoorPatchPreview };

/** Messaggio della trascrizione come serve alla selezione: id = nodo del thread. */
export type FrontDoorCardMessage = {
  id?: string;
  who?: "you" | "agent";
  role?: "user" | "assistant";
  frontDoor?: ConversationMessage["frontDoor"];
  intakeProposalId?: string;
  patchProposal?: ConversationMessage["patchProposal"];
};

function isAgentMessage(message: FrontDoorCardMessage): boolean {
  if (message.who !== undefined) return message.who === "agent";
  return message.role === "assistant";
}

function isUserMessage(message: FrontDoorCardMessage): boolean {
  if (message.who !== undefined) return message.who === "you";
  return message.role === "user";
}

export type FrontDoorCardsInput = {
  messages: readonly FrontDoorCardMessage[];
  /** Ultima proposta del lavoro, come la legge l'hook dell'accordo (Fonte=motore). */
  intakeProposal: { id: string; status: string } | null;
  /** Versione attuale del lavoro: un'anteprima di patch vale solo contro di essa. */
  workVersion: number;
  /** Anteprime già applicate o annullate localmente (per id del messaggio). */
  resolvedPatchIds?: readonly string[];
  /** Proposte chiuse con Annulla: la scheda si nasconde, il record resta. */
  dismissedProposalIds?: readonly string[];
};

/** Which outcome cards are live, keyed by the thread node id that produced them. */
export function frontDoorCards(input: FrontDoorCardsInput): FrontDoorCard[] {
  const resolved = new Set(input.resolvedPatchIds ?? []);
  const dismissed = new Set(input.dismissedProposalIds ?? []);
  let lastUserIndex = -1;
  input.messages.forEach((message, index) => {
    if (isUserMessage(message)) lastUserIndex = index;
  });
  const cards: FrontDoorCard[] = [];
  for (let index = 0; index < input.messages.length; index++) {
    const message = input.messages[index] as FrontDoorCardMessage;
    if (!isAgentMessage(message) || !message.id) continue;
    if (
      message.intakeProposalId &&
      input.intakeProposal &&
      message.intakeProposalId === input.intakeProposal.id
    ) {
      if (input.intakeProposal.status === "pending_confirmation") {
        if (!dismissed.has(message.intakeProposalId))
          cards.push({ kind: "agreement", id: message.id, state: "pending" });
      } else if (input.intakeProposal.status === "confirmed") {
        cards.push({ kind: "agreement", id: message.id, state: "confirmed" });
      }
      continue;
    }
    const front = message.frontDoor;
    const questions = front?.questions ?? [];
    if (front?.kind === "clarification" && questions.length > 0) {
      // Resta aperta finché la persona non ha risposto in chat.
      if (index > lastUserIndex)
        cards.push({ kind: "clarify", id: message.id, questions: [...questions] });
      continue;
    }
    const patch = message.patchProposal;
    if (patch && patch.base_version === input.workVersion && !resolved.has(message.id)) {
      cards.push({
        kind: "plan-change",
        id: message.id,
        summaryLines: patch.summary_lines,
        patch,
      });
    }
  }
  return cards;
}

/** Le schede vive di una trascrizione, pronte per lo slot per-messaggio. */
export function frontDoorCardMap(
  ...args: Parameters<typeof frontDoorCards>
): Map<string, FrontDoorCard> {
  return new Map(frontDoorCards(...args).map((card) => [card.id, card]));
}
