/**
 * Pure policy for guided recovery from a stale expected_version (409).
 *
 * The engine rejects a command whose expected_version is behind the work's
 * current revision (for example a chat message landed while an action was
 * being prepared). Instead of a dry error, the state is refreshed and the
 * person is invited to repeat the action. There is never an automatic silent
 * retry: the rejected command may have partially applied, so the retry must
 * be a fresh, explicit command.
 */
import { isHomunClientError } from "./homun-errors.ts";

export type ConflictRecoveryPlan =
  | { kind: "none" }
  | { kind: "refreshed"; message: string };

/** Preparing re-reads the current version: repeating it is enough. */
export const PREPARE_CONFLICT_MESSAGE =
  "Lo stato del lavoro è cambiato mentre questa azione veniva preparata (per esempio è arrivato un nuovo messaggio). Ho ricaricato i dati aggiornati: riprova ora.";
/** Approving is bound to the work version frozen in the proposal: the action
 *  must be prepared again on the refreshed state. */
export const APPROVE_CONFLICT_MESSAGE =
  "Lo stato del lavoro è cambiato prima dell'approvazione (per esempio è arrivato un nuovo messaggio). Ho ricaricato i dati aggiornati: prepara di nuovo l'azione e approvala.";

export function planConflictRecovery(
  cause: unknown,
  action: "prepare" | "approve" = "prepare",
): ConflictRecoveryPlan {
  if (isHomunClientError(cause) && cause.code === "version_conflict") {
    return {
      kind: "refreshed",
      message: action === "approve" ? APPROVE_CONFLICT_MESSAGE : PREPARE_CONFLICT_MESSAGE,
    };
  }
  return { kind: "none" };
}
