// P1 (fase primo-avvio): il registro della FINESTRA, PURA (nessun import di
// Electron: si prova con una BrowserWindow finta e i deps iniettati).
//
// Il difetto: Homun si apre, il Dock c'è l'icona, ma non si vede niente — e
// il registro sapeva solo «window-created» e «window-shown». Per Electron la
// finestra ERA creata e mostrata; del perché a schermo non ci fosse niente non
// restava una riga. Qui tutto quello che il registro deve raccontare di una
// finestra, sempre SENZA dati dell'utente (solo flag, numeri e misure; dell'URL
// di un caricamento fallito resta solo l'origine dell'app):
//   - il caricamento della pagina: did-start-loading, dom-ready,
//     did-finish-load (e did-fail-load con codice e descrizione);
//   - il renderer: render-process-gone col motivo, unresponsive/responsive;
//   - ready-to-show (quando la pagina ha il primo frame da mostrare);
//   - il PRIMO segnale dal renderer (IPC app:first-paint, dopo il primo
//     render di React): renderer-ready — una volta per finestra;
//   - la FOTOGRAFIA della finestra 5 s dopo ogni window-shown, in una riga
//     sola chiave=valore: visible, minimized, focused, fullscreen, bounds, il
//     display che la contiene (id e workArea), quanti display, app.isHidden(),
//     il caricamento in corso e se il renderer ha mai segnalato «pronto».
// Ogni riga porta ms=<millisecondi dall'avvio del main>.
import type { LifecycleFields, LifecycleLine } from './lifecycle-log'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Un display (quello di Electron: id e workArea, l'area senza menu e Dock). */
export interface DisplayLike {
  id: number
  workArea: Rect
}

type Listener = (...args: unknown[]) => void

/** Il webContents della finestra (l'interfaccia basta, i tipi di Electron la soddisfacerebbero). */
export interface WatchedWebContents {
  on(event: string, listener: Listener): unknown
  isLoading(): boolean
}

/** La finestra osservata (una BrowserWindow Electron, o il finto dei test). */
export interface WatchedWindow {
  on(event: string, listener: Listener): unknown
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  isFullScreen(): boolean
  getBounds(): Rect
  readonly webContents: WatchedWebContents
}

/** Le dipendenze di Electron (app, screen) e i timer, iniettabili nei test. */
export interface WatchDeps {
  /** app.isHidden() */
  appHidden(): boolean
  /** screen.getAllDisplays() */
  displays(): DisplayLike[]
  /** screen.getDisplayMatching(bounds): il display che contiene la finestra */
  displayMatching(bounds: Rect): DisplayLike
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Quanto dopo ogni window-shown si scatta la fotografia della finestra. */
export const WINDOW_SNAPSHOT_DELAY_MS = 5_000

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Dell'URL di un caricamento resta SOLO l'origine dell'app (homun://app/), o
 * quella del dev server locale: mai percorso, query o frammento — un URL
 * intero può portare dati dell'utente. Tutto il resto diventa «other».
 */
export function urlOriginForLog(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'homun:') return u.host === 'app' ? 'homun://app/' : 'other'
    if ((u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname)) return `${u.protocol}//${u.host}/`
  } catch {
    // non è un URL
  }
  return 'other'
}

/** True se i due rettangoli hanno almeno un pixel in comune. */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

const formatRect = (r: Rect): string => `${r.x},${r.y},${r.width}x${r.height}`

/** Un argomento di un evento Electron diventa campo del registro solo se è un valore semplice. */
const field = (v: unknown): string | number | boolean | undefined =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined

/**
 * La fotografia della finestra, PURA: i campi della riga unica. `inside` è
 * false quando i bounds non toccano la workArea di nessun display.
 */
export function describeWindow(
  win: WatchedWindow,
  state: { rendererReady: boolean },
  deps: WatchDeps
): LifecycleFields {
  const b = win.getBounds()
  const displays = deps.displays()
  const display = displays.length > 0 ? deps.displayMatching(b) : undefined
  return {
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    focused: win.isFocused(),
    fullscreen: win.isFullScreen(),
    bounds: formatRect(b),
    ...(display ? { display: display.id, 'work-area': formatRect(display.workArea) } : {}),
    displays: displays.length,
    inside: displays.some((d) => intersects(b, d.workArea)),
    'app-hidden': deps.appHidden(),
    loading: win.webContents.isLoading(),
    'renderer-ready': state.rendererReady
  }
}

/** Quello che accade al renderer di una finestra, per chi lo vuole sapere (P3.4: il cane da guardia). */
export interface WindowHooks {
  /** did-finish-load: la pagina è caricata */
  didFinishLoad?(): void
  /** did-fail-load: solo del frame principale conta */
  didFailLoad?(isMainFrame: boolean): void
  /** render-process-gone: il renderer è morto */
  renderProcessGone?(): void
}

/** Il registro di UNA finestra: lo tieni in mano tu (la chiudi con dispose). */
export interface WindowWatch {
  /** Il renderer ha MAI segnalato il primo paint (sopravvive ai reload). */
  rendererReady(): boolean
  /**
   * Il primo paint del renderer: la riga renderer-ready, una volta per
   * finestra. `framed` false quando il segnale è arrivato SENZA un frame
   * (pagina nascosta: finestra coperta o mai mostrata) — la riga porta frame=0.
   */
  firstPaint(framed?: boolean): void
  /**
   * La finestra si mostra SENZA l'evento «show» (era già visibile: show() non
   * lo emette): la riga window-shown, coi campi dati, e la fotografia a 5 s.
   */
  shown(fields?: LifecycleFields): void
  /** La fotografia ADESSO. */
  snapshot(): void
  /** La finestra è chiusa: niente altre righe e niente timer appesi. */
  dispose(): void
}

/**
 * Osserva una finestra appena nata: collega gli eventi del renderer e della
 * finestra al registro del ciclo di vita. Ogni mostra VERA della finestra —
 * l'evento «show», anche quando lo fa il sistema — scrive window-shown e
 * rimette in corsa la fotografia (una sola pendente per finestra); quando la
 * finestra era già visibile la riga la scrive shown(), che chiama la porta
 * unica della principale.
 */
export function watchWindow(
  win: WatchedWindow,
  log: LifecycleLine,
  deps: WatchDeps,
  hooks: WindowHooks = {}
): WindowWatch {
  let everReady = false
  let disposed = false
  let timer: unknown = null

  const line = (event: string, fields?: LifecycleFields): void => {
    if (!disposed) log.line(event, { ms: log.sinceBoot(), ...fields })
  }

  const snapshot = (): void => {
    timer = null
    if (disposed) return
    try {
      line('window-snapshot', describeWindow(win, { rendererReady: everReady }, deps))
    } catch {
      // lo schermo o la finestra non rispondono: la riga esce lo stesso, mai
      // un'eccezione nel main (aprirebbe il dialogo d'errore)
      line('window-snapshot', { error: 1 })
    }
  }
  const scheduleSnapshot = (): void => {
    if (disposed) return
    if (timer !== null) deps.clearTimeout(timer)
    timer = deps.setTimeout(snapshot, WINDOW_SNAPSHOT_DELAY_MS)
  }

  const wc = win.webContents
  wc.on('did-start-loading', () => line('did-start-loading'))
  wc.on('dom-ready', () => line('dom-ready'))
  wc.on('did-finish-load', () => {
    line('did-finish-load')
    if (!disposed) hooks.didFinishLoad?.()
  })
  wc.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    line('did-fail-load', { code: field(code), desc: field(desc), main: field(isMainFrame), origin: urlOriginForLog(String(url ?? '')) })
    if (!disposed) hooks.didFailLoad?.(isMainFrame === true)
  })
  wc.on('render-process-gone', (_event, details) => {
    const d = (details ?? {}) as { reason?: unknown; exitCode?: unknown }
    line('render-process-gone', { reason: field(d.reason), exit: field(d.exitCode) })
    if (!disposed) hooks.renderProcessGone?.()
  })
  wc.on('unresponsive', () => line('unresponsive'))
  wc.on('responsive', () => line('responsive'))
  win.on('ready-to-show', () => line('ready-to-show'))
  const shown = (fields?: LifecycleFields): void => {
    line('window-shown', fields)
    scheduleSnapshot()
  }
  win.on('show', () => shown())

  return {
    rendererReady: () => everReady,
    firstPaint(framed = true): void {
      if (disposed || everReady) return
      everReady = true
      line('renderer-ready', framed ? {} : { frame: 0 })
    },
    shown,
    snapshot,
    dispose(): void {
      disposed = true
      if (timer !== null) deps.clearTimeout(timer)
      timer = null
    }
  }
}
