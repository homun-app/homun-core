// P3.2 (fase primo-avvio): la finestra si mostra quando ha qualcosa da
// mostrare, ma non aspetta per sempre. PURA (nessun import di Electron:
// finestra, app e timer iniettabili).
//
// Il difetto: la principale nasceva GIÀ visibile (show: true) appena creata,
// con dentro solo lo sfondo #0b0d10. Se in quel momento l'app non era attiva
// — l'avvio senza attivazione di sistema, oppure il daemon che si porta via
// l'attivazione del bundle (due processi dello stesso bundle: vedi la
// riproduzione di P2) — la finestra restava dietro le finestre dell'app che
// aveva il fuoco: per Electron «mostrata» (isVisible true, evento show), per
// chi guarda niente.
//
// Ora la finestra nasce nascosta e si mostra su ready-to-show (la pagina ha
// il suo primo frame): un ripiego la mostra dopo SHOW_FALLBACK_MS comunque,
// con la riga show-fallback nel registro. E la mostra porta l'app davanti: su
// macOS app.focus({ steal: true }) e poi win.focus() — l'ha chiesta chi ha
// appena aperto Homun.
import type { LifecycleLine } from './lifecycle-log'

/** Quanto si aspetta ready-to-show prima di mostrare comunque. */
export const SHOW_FALLBACK_MS = 3_000

export interface ShowableWindow {
  once(event: string, listener: () => void): unknown
  show(): void
  focus(): void
  isDestroyed(): boolean
}

export interface ShowPolicyDeps<W> {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** Porta l'app e la finestra davanti (bringWindowToFront con l'app e la piattaforma vere). */
  bringToFront(win: W): void
}

/**
 * Porta la finestra davanti. Su macOS PRIMA l'app (app.focus({ steal: true })):
 * una finestra di un'app non attiva resta dietro le finestre di quella attiva,
 * per quanto la si mostri e le si dia il focus.
 */
export function bringWindowToFront<W extends { focus(): void }>(
  win: W,
  app: { focus(options: { steal: boolean }): void },
  platform: string
): void {
  if (platform === 'darwin') app.focus({ steal: true })
  win.focus()
}

/**
 * Mostra la finestra su ready-to-show, o dopo il ripiego. `bringToFront`
 * viene chiamato subito dopo lo show. dispose() (finestra chiusa) toglie il
 * timer del ripiego; una finestra distrutta non si mostra più.
 */
export function showWhenReady<W extends ShowableWindow>(
  win: W,
  log: LifecycleLine,
  deps: ShowPolicyDeps<W>
): { shown(): boolean; dispose(): void } {
  let didShow = false
  let disposed = false
  let timer: unknown = deps.setTimeout(() => show('show-fallback'), SHOW_FALLBACK_MS)

  const show = (reason: 'ready-to-show' | 'show-fallback'): void => {
    if (didShow || disposed || win.isDestroyed()) return
    didShow = true
    if (timer !== null) {
      deps.clearTimeout(timer)
      timer = null
    }
    win.show()
    if (reason === 'show-fallback') log.line('show-fallback', { ms: log.sinceBoot() })
    deps.bringToFront(win)
  }

  win.once('ready-to-show', () => show('ready-to-show'))
  return {
    shown: () => didShow,
    dispose(): void {
      disposed = true
      if (timer !== null) deps.clearTimeout(timer)
      timer = null
    }
  }
}
