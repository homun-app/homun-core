// P3.4 (fase primo-avvio): il cane da guardia del renderer. PURA (azioni,
// registro e timer iniettabili).
//
// Il difetto: la pagina poteva non arrivare mai al paint (caricamento
// fallito, renderer morto, o muto) e la finestra restava lì, con il suo
// sfondo — per sempre. Ora, per OGNI avvio dell'app (una sola istanza):
//   - entro 15 s dal did-finish-load non arriva renderer-ready, oppure arriva
//     did-fail-load (del frame principale) o render-process-gone → UN solo
//     webContents.reload();
//   - se non basta (la pagina si ricarica e resta muta, o non si ricarica
//     nemmeno, o cade di nuovo) → la finestra si chiude e si ricrea UNA volta
//     dalla porta unica (showMainWindow di W1);
//   - poi si ferma: mai un ciclo, al massimo 1 reload + 1 ricreazione per
//     avvio (un terzo segnale lo dice con step=stop).
// Ogni passo una riga: renderer-watchdog step=… reason=… ms=…
import type { LifecycleLine } from './lifecycle-log'

/** Quanto si aspetta il primo segnale del renderer dopo il caricamento (o dopo il reload). */
export const RENDERER_READY_TIMEOUT_MS = 15_000

export type WatchdogReason = 'no-first-paint' | 'did-fail-load' | 'render-process-gone'

export interface WatchdogActions {
  /** UN webContents.reload() della principale */
  reload(): void
  /** La principale si chiude e si ricrea dalla porta unica (showMainWindow) */
  recreate(): void
}

export interface WatchdogDeps {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export function createRendererWatchdog(log: LifecycleLine, actions: WatchdogActions, deps: WatchdogDeps) {
  let reloaded = false
  let recreated = false
  let saidStop = false
  let disposed = false
  /** c'è stato un caricamento della pagina: da qui in poi gli eventi contano */
  let loaded = false
  let timer: unknown = null

  const disarm = (): void => {
    if (timer !== null) deps.clearTimeout(timer)
    timer = null
  }
  const arm = (): void => {
    disarm()
    timer = deps.setTimeout(() => {
      timer = null
      if (!disposed) step('no-first-paint')
    }, RENDERER_READY_TIMEOUT_MS)
  }

  const step = (reason: WatchdogReason): void => {
    if (disposed) return
    disarm()
    if (!reloaded) {
      reloaded = true
      log.line('renderer-watchdog', { step: 'reload', reason, ms: log.sinceBoot() })
      actions.reload()
      // se il reload non ricarica nemmeno la pagina (nessun did-finish-load),
      // il conteggio per la ricreazione ricomincia da qui
      arm()
      return
    }
    if (!recreated) {
      recreated = true
      log.line('renderer-watchdog', { step: 'recreate', reason, ms: log.sinceBoot() })
      actions.recreate()
      return
    }
    if (!saidStop) {
      saidStop = true
      log.line('renderer-watchdog', { step: 'stop', reason, ms: log.sinceBoot() })
    }
  }

  return {
    /** did-finish-load della principale: il conteggio del primo paint parte da qui */
    onDidFinishLoad(): void {
      if (disposed || recreated) return
      loaded = true
      arm()
    },
    /** Il renderer ha montato (IPC app:first-paint): tutto fermo */
    onRendererReady(): void {
      disarm()
    },
    /** did-fail-load: solo del frame principale, e solo dopo un caricamento */
    onDidFailLoad(isMainFrame: boolean): void {
      if (!isMainFrame || !loaded) return
      step('did-fail-load')
    },
    onRenderProcessGone(): void {
      if (!loaded) return
      step('render-process-gone')
    },
    /** L'app sta uscendo: niente più timer né azioni */
    dispose(): void {
      disposed = true
      disarm()
    }
  }
}
