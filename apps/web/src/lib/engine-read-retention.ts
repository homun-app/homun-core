/**
 * Politica pura di ritenzione dei dati letti dal motore (Fonte=motore).
 *
 * La stessa decisione serve in tre punti — snapshot del workspace, trascrizione
 * aperta, avvisi della chat — e vive qui, una volta sola:
 * - un errore di connessione (`engine_unavailable`) conserva ciò che il motore
 *   aveva già consegnato: resta visibile in sola lettura, l'avviso lo racconta;
 * - ogni altro esito (lettura negata, sessione revocata, dati non validi)
 *   scarta ciò che era visibile, come sempre.
 *
 * Nessun dato inventato e nessun passaggio alla simulazione: si conserva solo
 * ciò che il motore aveva già restituito.
 */
import type { EngineFollowupNotice } from "./engine-domain-client.ts";
import type { EngineAgentProfile } from "./engine-agents-client.ts";
import type { EngineProject, EngineTeam } from "./engine-projects-client.ts";
import type { EngineRoutine } from "./engine-routines-client.ts";
import { isHomunClientError } from "./homun-errors.ts";

/**
 * La caduta della connessione al motore locale: lo stesso guasto che accende
 * l'avviso «motore irraggiungibile».
 */
export function isEngineConnectionLoss(cause: unknown): boolean {
  return isHomunClientError(cause) && cause.code === "engine_unavailable";
}

/** Le sei collezioni dello snapshot del workspace, come le consegna il motore. */
export type EngineWorkspaceCollections = {
  rawWorks: Array<Record<string, unknown>>;
  projects: EngineProject[];
  agents: EngineAgentProfile[];
  teams: EngineTeam[];
  routines: EngineRoutine[];
  followups: Array<EngineFollowupNotice & { conversationId: string; conversationTitle: string }>;
};

export function emptyEngineWorkspaceCollections(): EngineWorkspaceCollections {
  return { rawWorks: [], projects: [], agents: [], teams: [], routines: [], followups: [] };
}

/**
 * Cosa resta visibile del workspace dopo una lettura fallita: l'ultimo
 * snapshot consegnato sopravvive solo a un errore di connessione; le letture
 * negate, revocate o non valide svuotano lavori, conversazioni (followup),
 * progetti, agenti, team e routine.
 */
export function workspaceAfterReadFailure(
  cause: unknown,
  last: EngineWorkspaceCollections,
): EngineWorkspaceCollections {
  return isEngineConnectionLoss(cause) ? last : emptyEngineWorkspaceCollections();
}
