// RV1 (fase beta.2): l'app eseguita fuori da Applicazioni o in sola lettura.
// Copiando l'app dal dmg con `ditto` la quarantena resta: macOS la avvia in
// App Translocation (una copia in sola lettura sotto /private/var/folders) e
// da lì Squirrel.Mac non può sostituirla — l'aggiornamento fallirebbe — e il
// daemon staccato resterebbe acceso da quel percorso anche dopo ⌘Q. Come
// chiede lo stato dell'arte di Electron: app.isInApplicationsFolder() e
// app.moveToApplicationsFolder(), con dialogo nativo (testi Lingui del
// catalogo UI, it/en) PRIMA di avviare il daemon.
//
// Tutto qui è PURO o a dipendenze iniettate (dialoghi, sposta, stop del
// daemon): i test passano finti, il main cabla i veri (index.ts / ipc.ts).
import { app, dialog } from 'electron'
import { formatUi, ui } from '../shared/ui-text'
import { UI } from '../shared/ui-messages'
import { mainLanguage } from './i18n'
import { stopRunningDaemon } from './daemon-client'

/** Il marcatore del percorso di App Translocation di macOS. */
export const APP_TRANSLOCATION_MARKER = '/AppTranslocation/'

/** La decisione sull'avvio: tutto a posto, chiedere lo spostamento, saltare. */
export type AppLocationAction = 'ok' | 'ask-move' | 'skip'

/** L'eseguibile gira in una copia translocata (sola lettura)? Pura. */
export function isAppTranslocatedPath(execPath: string): boolean {
  return execPath.includes(APP_TRANSLOCATION_MARKER)
}

export interface AppLocationInput {
  isPackaged: boolean
  platform: NodeJS.Platform
  /** app.isInApplicationsFolder() */
  inAppsFolder: boolean
  /**
   * Le condizioni dell'updater GIÀ DECISE dal chiamante
   * (shouldAutoCheckUpdates(app.isPackaged, env, hasUpdateConfig())): qui non
   * si ricalcolano — il controllo vale solo dove l'updater è attivo, quindi
   * test env (SANDBOT_TEST_*), build --dir e dev restano fuori.
   */
  updaterEnabled: boolean
  /** process.execPath: serve a riconoscere la copia translocata */
  execPath: string
}

/**
 * PURA: che fare della posizione dell'app all'avvio. 'ask-move' solo per una
 * build pacchettizzata su macOS dove l'updater è attivo e l'app NON sta in
 * Applicazioni — o gira translocata, anche se il percorso dicesse il
 * contrario (la copia è in sola lettura: da lì non si aggiorna).
 */
export function appLocationAction(i: AppLocationInput): AppLocationAction {
  if (i.platform !== 'darwin') return 'skip'
  if (!i.isPackaged) return 'skip'
  if (!i.updaterEnabled) return 'skip'
  if (isAppTranslocatedPath(i.execPath)) return 'ask-move'
  return i.inAppsFolder ? 'ok' : 'ask-move'
}

/**
 * L'esito del flusso di spostamento:
 * - 'moved'            — Electron ha già riavviato l'app dalla nuova posizione
 *                        (questa istanza sta uscendo: l'avvio non prosegue);
 * - 'declined'         — «Non ora»: si parte normalmente, aggiornamenti spenti
 *                        per la sessione;
 * - 'not-moved'        — sostituzione negata, autorizzazione annullata o
 *                        copertura fallita: come «Non ora»;
 * - 'daemon-not-stopped' / 'still-running' — non si sostituisce MAI un'app
 *                        che sta girando: si resta come «Non ora» col messaggio.
 */
export type MoveOutcome = 'moved' | 'declined' | 'not-moved' | 'daemon-not-stopped' | 'still-running'

export interface MoveToApplicationsDeps {
  /** Il dialogo d'apertura («Sposta in Applicazioni» / «Non ora»): true = sposta. */
  askMove(): Promise<boolean>
  /** «Sostituisci la versione in Applicazioni?» (sync, come il conflictHandler). */
  confirmReplace(): boolean
  /** app.moveToApplicationsFolder({ conflictHandler }) — true: spostata e riavviata. */
  moveToApplications(conflictHandler: (conflictType: 'exists' | 'existsAndRunning') => boolean): boolean
  /**
   * Ferma il daemon VIVO con il meccanismo dell'updater (la RPC daemon:restart
   * di A2 e l'attesa dell'uscita). true quando alla fine non gira nessuno.
   */
  stopDaemon(): Promise<boolean>
  /** Il messaggio chiaro quando lo spostamento non riesce. */
  reportFailure(message: string): void
  /** Il dettaglio dell'errore di copertura, se c'è. */
  reportError(message: string): void
}

/**
 * Il flusso completo dello spostamento, con tutto iniettato. Il gestore dei
 * conflitti è SINCRONO (lo chiama Electron), quindi:
 * - 'exists': si chiede conferma UNA volta («Sostituisci la versione in
 *   Applicazioni?») e si prosegue se l'utente dice sì;
 * - 'existsAndRunning': NON si sostituisce mai un'app che sta girando — il
 *   tentativo si annulla, si ferma prima il daemon (il meccanismo
 *   dell'updater), poi si RIPROVA una volta: a quel punto il conflitto è
 *   'exists'. Se fermarlo non riesce, o in Applicazioni gira ancora
 *   qualcosa, si annulla con un messaggio chiaro.
 */
export async function moveToApplicationsFlow(deps: MoveToApplicationsDeps): Promise<MoveOutcome> {
  if (!(await deps.askMove())) return 'declined'
  let replaceConfirmed = false
  for (let attempt = 0; ; attempt++) {
    let runningFromDestination = false
    let moved: boolean
    try {
      moved = deps.moveToApplications((conflictType) => {
        if (conflictType === 'existsAndRunning') {
          // mai la sostituzione (nemmeno il default di Electron, che darebbe
          // il focus a quella in esecuzione): si ferma il daemon e si riprova
          runningFromDestination = true
          return false
        }
        if (!replaceConfirmed) replaceConfirmed = deps.confirmReplace()
        return replaceConfirmed
      })
    } catch {
      deps.reportError(moveText(UI.moveToApplicationsCopyFailed))
      return 'not-moved'
    }
    if (moved) return 'moved'
    if (!runningFromDestination) return 'not-moved'
    if (attempt > 0) {
      deps.reportFailure(moveText(UI.moveToApplicationsStillRunning))
      return 'still-running'
    }
    if (!(await deps.stopDaemon())) {
      deps.reportFailure(moveText(UI.moveToApplicationsDaemonNotStopped))
      return 'daemon-not-stopped'
    }
  }
}

// ---- lo stato della sessione ----

/**
 * Questa sessione deve ancora spostare l'app in Applicazioni? Lo accende
 * index.ts quando la posizione chiede lo spostamento e l'utente non l'ha
 * fatto: gli aggiornamenti restano spenti e le Impostazioni mostrano il
 * motivo con il bottone che ripropone lo spostamento.
 */
let needsMove = false

export function setAppNeedsMove(v: boolean): void {
  needsMove = v
}

export function appNeedsMove(): boolean {
  return needsMove
}

/** «Controlla aggiornamenti» con lo spostamento pendente: risposta esplicita, mai silenzio. */
export function updateCheckResultWhenMoveNeeded(current: string): {
  current: string
  available: false
  version: null
  needsMove: true
} {
  return { current, available: false, version: null, needsMove: true }
}

/** Il testo Lingui del catalogo UI nella lingua attiva del main. */
function moveText(m: Parameters<typeof ui>[0]): string {
  return formatUi(ui(m), mainLanguage())
}

/**
 * Le dipendenze VERE (electron): dialoghi nativi, sposta con conflictHandler,
 * stop del daemon senza mai avviarne uno. Si usa all'avvio (index.ts) e dal
 * bottone delle Impostazioni (ipc.ts) — lo stesso flusso.
 */
export function electronMoveDeps(): MoveToApplicationsDeps {
  return {
    askMove: async () => {
      const r = await dialog.showMessageBox({
        type: 'warning',
        message: moveText(UI.moveToApplicationsTitle),
        detail: moveText(UI.moveToApplicationsBody),
        buttons: [moveText(UI.moveToApplicationsNow), moveText(UI.moveToApplicationsLater)],
        defaultId: 0,
        cancelId: 1
      })
      return r.response === 0
    },
    confirmReplace: () =>
      dialog.showMessageBoxSync({
        type: 'warning',
        message: moveText(UI.moveToApplicationsReplaceTitle),
        detail: moveText(UI.moveToApplicationsReplaceBody),
        buttons: [moveText(UI.moveToApplicationsReplaceYes), moveText(UI.moveToApplicationsReplaceNo)],
        defaultId: 0,
        cancelId: 1
      }) === 0,
    moveToApplications: (conflictHandler) => app.moveToApplicationsFolder({ conflictHandler }),
    stopDaemon: () => stopRunningDaemon(),
    reportFailure: (message) => {
      dialog.showMessageBoxSync({ type: 'warning', message: moveText(UI.moveToApplicationsFailedTitle), detail: message, buttons: ['OK'] })
    },
    reportError: (message) => {
      dialog.showMessageBoxSync({ type: 'warning', message: moveText(UI.moveToApplicationsFailedTitle), detail: message, buttons: ['OK'] })
    }
  }
}

/** Il flusso con le dipendenze vere (avvio e Impostazioni). */
export async function proposeMoveToApplications(): Promise<MoveOutcome> {
  return moveToApplicationsFlow(electronMoveDeps())
}
