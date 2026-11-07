// R1 (fase app — ritocchi): gli avvisi in chat non sono tutti errori. Ogni
// notice ha una SEVERITÀ ESPLICITA in questa tabella (l'id del catalogo UI,
// quello che vive in meta.ui): 'info' sta grigia come le righe di sistema,
// 'warning' è ambra (il token --waiting, contrasto ≥ 4,5:1 in chiaro e
// scuro), 'error' resta rossa come oggi. Le notice con azione (errori del
// modello, ripiego) continuano a rendersi col loro banner.
//
// La tabella deve coprire TUTTI gli id usati come notice: il test
// notice-severity.test.ts scansiona i sorgenti (come il test di coerenza
// ipc) e fallisce se un id nuovo manca — così ogni notice nuova va
// classificata qui, non tinta di rosso per default.
export type NoticeSeverity = 'info' | 'warning' | 'error'

/** La severità di ogni notice: id del catalogo UI → info | warning | error.
 *  Esportata per il test di copertura (scansione dei sorgenti). */
export const NOTICE_SEVERITY: Readonly<Record<string, NoticeSeverity>> = {
  // ---- info: righe grigie, centrate (come gli eventi) ----
  'notice.agentBusyQueued': 'info',
  'notice.onboardingWaitingProvider': 'info',
  'notice.routinesResumed': 'info',
  'notice.noRoutinesToResume': 'info',
  'notice.boxPreparing': 'info',
  'notice.boxMigrated': 'info',
  'notice.boxMigratedFailed': 'info',
  'notice.awayLine': 'info',
  'notice.resume': 'info',
  'notice.wakeNudge': 'info',
  'notice.taskCancelled': 'info',
  // ---- error: banner con la via d'uscita (fase use-app: Accessibilità) ----
  'notice.computerAccessibility': 'error',
  // ---- warning: ambra (qualcosa è stato saltato o degradato, ma il bot lavora) ----
  'notice.agentBusyDiscard': 'warning',
  'notice.queueFull': 'warning',
  'notice.routineSkipped': 'warning',
  'notice.imagesNotSeen': 'warning',
  'notice.ownModelUnavailable': 'warning',
  'notice.routineModelUnavailable': 'warning',
  'notice.approvalExpired': 'warning',
  'notice.stepsLimit': 'warning',
  'notice.deniedByPermissions': 'warning',
  // i ripieghi del modello: banner di sempre, qui classificati warning
  'notice.modelFallback': 'warning',
  'notice.modelFallbackRoute': 'warning',
  'notice.modelRouteCooled': 'warning',
  // ---- error: rossa come oggi ----
  'notice.modelError': 'error',
  'notice.modelNotResponding': 'error',
  'notice.configureProviderFirst': 'error',
  'notice.modelEmpty': 'error',
  'notice.toolLoop': 'error',
  'rpc.draftSendError': 'error',
  'rpc.draftNoVia': 'error',
  'rpc.draftViaRejected': 'error',
  'rpc.draftBlocked': 'error'
}

/**
 * La severità di una notice dal suo id UI (meta.ui.id). Senza id, o con un
 * id fuori tabella → 'info': mai rosso per default (il test di copertura
 * obbliga a classificare gli id nuovi, questo è solo una rete di sicurezza
 * per le entry vecchie del database).
 */
export function noticeSeverity(uiId: string | undefined): NoticeSeverity {
  if (!uiId) return 'info'
  return NOTICE_SEVERITY[uiId] ?? 'info'
}
