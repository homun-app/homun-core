/**
 * Gli stati del motore raccontati nel thread della chat — decidere, non disegnare.
 *
 * Da qui esce l'elenco degli avvisi derivati dallo stato del client
 * (`EngineWorkspaceState`): la UI li colloca negli slot del thread e del
 * composer. Non sono messaggi della conversazione: non entrano mai
 * nell'elenco messaggi del runtime, non vengono inviati al motore né al
 * modello. Simulazione e motore restano dichiarati e non si mescolano.
 */

import { homunErrorFromHttp } from "./homun-errors.ts";

export type ChatStatusActionId = "refresh" | "open-models";

export type ChatStatusAction = { id: ChatStatusActionId; label: string };

export type ChatStatusNoticeKind =
  "simulation-source" | "engine-unreachable" | "engine-error" | "followup";

export type ChatStatusNotice = {
  /** Identità stabile della condizione: un avviso per condizione, aggiornato sul posto. */
  id: string;
  scope: "global" | "conversation";
  kind: ChatStatusNoticeKind;
  severity: "info" | "warning" | "error";
  text: string;
  hint?: string;
  actions?: ChatStatusAction[];
  /** Errore tipizzato ripreso da `HomunErrorNotice`. */
  error?: unknown;
  conversationId?: string;
  conversationTitle?: string;
  commandId?: string;
  followup?: {
    status: "processing" | "retry_scheduled" | "failed";
    attempts: number;
    errorCode: string | null;
  };
};

export type ChatStatusFollowup = {
  commandId: string;
  status: "processing" | "retry_scheduled" | "failed";
  errorCode: string | null;
  attempts: number;
  conversationId: string;
  conversationTitle: string;
};

/** Il sottoinsieme di `EngineWorkspaceState` da cui derivano gli avvisi. */
export type ChatStatusState = {
  dataSource: "simulation" | "engine";
  gateError: unknown;
  error: unknown;
  followups: ReadonlyArray<ChatStatusFollowup>;
  /** Presente quando la UI può aprire Impostazioni → modelli. */
  canOpenModels?: boolean;
  /** Opzionale: completa l'hint quando l'inventario lavori è ancora vuoto. */
  workCount?: number;
};

const SIMULATION_SOURCE_ID = "simulation-source";

/** La dichiarazione di fonte della simulazione, unica e sempre uguale. */
export function simulationSourceNotice(): ChatStatusNotice[] {
  return [
    {
      id: SIMULATION_SOURCE_ID,
      scope: "global",
      kind: "simulation-source",
      severity: "info",
      text: "Fonte: simulazione — nessun dato reale è collegato.",
    },
  ];
}

/** Una condizione per riga, nell'ordine in cui la conversazione le legge. */
export function chatStatusNotices(state: ChatStatusState): ChatStatusNotice[] {
  if (state.dataSource === "simulation") {
    return simulationSourceNotice();
  }
  if (state.dataSource !== "engine") {
    return [];
  }
  const notices: ChatStatusNotice[] = [];
  if (state.gateError != null) {
    const actions: ChatStatusAction[] = [{ id: "refresh", label: "Riprova la connessione" }];
    if (state.canOpenModels) {
      actions.push({ id: "open-models", label: "Apri modelli" });
    }
    notices.push({
      id: "engine-unreachable",
      scope: "global",
      kind: "engine-unreachable",
      severity: "error",
      text: "Homun (motore) non è raggiungibile su questo computer. I lavori restano sul percorso motore — non passiamo alla simulazione.",
      hint:
        `Verifica che Homun sia avviato, poi riprova${state.canOpenModels ? " o controlla i modelli collegati" : ""}.` +
        (state.workCount === 0
          ? " La lista lavori resta vuota finché la connessione non torna."
          : ""),
      actions,
      error: state.gateError,
    });
  }
  if (state.error != null) {
    notices.push({
      id: "engine-error",
      scope: "global",
      kind: "engine-error",
      severity: "error",
      text: "L'ultima operazione verso il motore non è riuscita.",
      error: state.error,
    });
  }
  for (const followup of state.followups) {
    const failed = followup.status === "failed";
    notices.push({
      id: `followup:${followup.commandId}`,
      scope: "conversation",
      kind: "followup",
      severity: failed ? "error" : followup.status === "retry_scheduled" ? "warning" : "info",
      text: failed
        ? `Risposta non completata dopo ${followup.attempts} tentativ${followup.attempts === 1 ? "o" : "i"}. Il recupero automatico è terminato.`
        : followup.status === "retry_scheduled"
          ? "Risposta interrotta; un nuovo tentativo è programmato."
          : "Risposta in elaborazione o in attesa di recupero.",
      conversationId: followup.conversationId,
      conversationTitle: followup.conversationTitle,
      commandId: followup.commandId,
      followup: {
        status: followup.status,
        attempts: followup.attempts,
        errorCode: followup.errorCode,
      },
      ...(failed
        ? {
            // stesso errore tipizzato del banner: codice engine → HomunClientError
            error: homunErrorFromHttp(
              0,
              {
                detail: {
                  code: followup.errorCode,
                  message: "La risposta non può essere recuperata automaticamente.",
                },
              },
              "Risposta non completata.",
            ),
          }
        : {}),
    });
  }
  return notices;
}

export type ChatStatusLayout = {
  /** Condizioni globali: sopra il campo di scrittura della conversazione aperta (o della schermata iniziale). */
  aboveComposer: ChatStatusNotice[];
  /** Dichiarazione di fonte in cima al thread (solo simulazione). */
  threadTop: ChatStatusNotice[];
  /** Condizioni della conversazione aperta, in fondo al thread. */
  threadEnd: ChatStatusNotice[];
};

/** Colloca gli avvisi nei punti del thread che non passano dai messaggi. */
export function chatStatusLayout(
  notices: ReadonlyArray<ChatStatusNotice>,
  openConversationId: string | null,
): ChatStatusLayout {
  const layout: ChatStatusLayout = {
    aboveComposer: [],
    threadTop: [],
    threadEnd: [],
  };
  for (const notice of notices) {
    if (notice.kind === "simulation-source") {
      layout.threadTop.push(notice);
      continue;
    }
    if (notice.scope === "global") {
      layout.aboveComposer.push(notice);
      continue;
    }
    if (openConversationId && notice.conversationId === openConversationId) {
      layout.threadEnd.push(notice);
    }
  }
  return layout;
}

/** Indicatore discreto della barra laterale per la conversazione con followup attivi. */
export function conversationFollowupBadge(
  followups: ReadonlyArray<Pick<ChatStatusFollowup, "status">>,
): { tone: "attention" | "error"; title: string } | null {
  if (!followups.length) return null;
  if (followups.some((f) => f.status === "failed")) {
    return { tone: "error", title: "Risposta non completata: apri la conversazione" };
  }
  return { tone: "attention", title: "Risposta in elaborazione o in attesa di recupero" };
}
