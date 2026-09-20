/**
 * Pure board-move checks for the simulated task board.
 * Returns an Italian error message, or null when the move is allowed.
 */

import { isHumanMember, type MemberProfile } from "./conversation-members.ts";
import { scenarioForWork, type ConversationScenario } from "./conversation-scenarios.ts";
import type { Phase, Work } from "./conversation-types.ts";

type Profiles = Record<string, MemberProfile> | undefined;

export function validateBoardMove(args: {
  target: Work | undefined;
  phase: string;
  viewer: string;
  scenarios: ConversationScenario[];
  removedPeople: string[] | undefined;
  profiles: Profiles;
}): string | null {
  const { target, phase, viewer, scenarios, removedPeople, profiles } = args;
  if (!target) return "Compito non disponibile.";
  if (target.request?.status === "pending")
    return `Serve prima il contributo di ${target.request.to}.`;
  const agent = scenarioForWork(target, scenarios).agent;
  if (removedPeople?.includes(agent))
    return "L’agente è stato eliminato: il lavoro rimane nello storico.";
  if (target.phase === phase) return "Il compito è già in questa colonna.";
  const supervisor = isHumanMember(agent, profiles)
    ? target.requester || "Fabio"
    : target.reviewer || target.requester || "Fabio";
  if (viewer !== supervisor) return "La verifica spetta al supervisore di questo lavoro.";
  const allowed =
    (target.phase === "review" && phase === "approved") ||
    (target.phase === "approved" && phase === "review");
  if (!allowed)
    return "Apri la conversazione per fornire il contributo o generare il risultato prima di cambiare stato.";
  return null;
}

export function boardMoveSuccessMessage(phase: string): string {
  return phase === "approved"
    ? "Risultato approvato. Nessuna azione esterna."
    : "Risultato riaperto per la verifica.";
}

export function applyBoardMove(
  work: Work,
  phase: Phase,
  viewer: string,
): Work {
  return {
    ...work,
    phase,
    autoDelivered: false,
    approvedBy: phase === "approved" ? viewer : "",
    messages: [
      ...work.messages,
      {
        who: "you",
        text:
          phase === "approved"
            ? "Ho verificato e approvato il risultato dalla bacheca."
            : "Riapro il risultato per una nuova verifica.",
      },
    ],
  };
}
