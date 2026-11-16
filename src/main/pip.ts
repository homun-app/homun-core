// SV4 (fase schermo-vivo) — LA FINESTRA PiP: una BrowserWindow DEDICATA del
// processo main (NON la Document Picture-in-Picture API: in Electron non è
// documentata e la sua finestra vive solo finché vive quella che l'ha aperta),
// sempre sopra le altre app (floating, visibile in tutti gli spazi anche a
// schermo pieno), rapporto bloccato a 16:10, larghezza minima 240 e massima
// 960, trascinabile ovunque. Sicurezza UGUALE alla finestra principale.
//
// Qui NIENTE importazioni di Electron: le parti pure (opzioni, bounds) e il
// manager con dipendenze INIETTABILI — i test passano la finestra finta, il
// main passa l'adattatore vero (src/main/index.ts).
import type { SandbotEvent } from '../shared/types'

/** Il rapporto della PiP: 16:10 come la zona dell'anteprima (SV2). */
export const PIP_ASPECT = 16 / 10

/** Larghezza minima della PiP (px). */
export const PIP_MIN_WIDTH = 240

/** Larghezza massima della PiP (px). */
export const PIP_MAX_WIDTH = 960

/** L'impostazione che ricorda posizione e dimensione. */
export const PIP_BOUNDS_SETTING = 'ui.pip.bounds'

/** Un rettangolo sullo schermo (come i bounds di Electron). */
export interface PipRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Le opzioni della finestra PiP (PURA). Sicurezza come la finestra principale:
 * stesso preload, contextIsolation, niente nodeIntegration, sandbox VERA,
 * niente webview. Senza cornice, angoli arrotondati, ombra, ridimensionabile
 * con i limiti 240–960 di larghezza.
 */
export function pipWindowOptions(preloadPath: string, bounds: PipRect): Record<string, unknown> {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: PIP_MIN_WIDTH,
    maxWidth: PIP_MAX_WIDTH,
    minHeight: Math.round(PIP_MIN_WIDTH / PIP_ASPECT),
    maxHeight: Math.round(PIP_MAX_WIDTH / PIP_ASPECT),
    frame: false,
    roundedCorners: true,
    hasShadow: true,
    resizable: true,
    useContentSize: true,
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  }
}

/**
 * La PRIMA volta: in basso a destra dello schermo dove sta Homun (il workArea
 * del display che la contiene), con un piccolo margine (PURE).
 */
export function defaultPipBounds(workArea: PipRect): PipRect {
  const width = 360
  const height = Math.round(width / PIP_ASPECT)
  const margin = 16
  return {
    x: workArea.x + Math.max(workArea.width - width - margin, 0),
    y: workArea.y + Math.max(workArea.height - height - margin, 0),
    width,
    height
  }
}

/** Il rettangolo del display che contiene (anche in parte) il bounds dato. */
function displayOf(saved: PipRect, displays: Array<{ workArea: PipRect }>): { workArea: PipRect } | null {
  let best: { workArea: PipRect; overlap: number } | null = null
  for (const d of displays) {
    const w = Math.min(saved.x + saved.width, d.workArea.x + d.workArea.width) - Math.max(saved.x, d.workArea.x)
    const h = Math.min(saved.y + saved.height, d.workArea.y + d.workArea.height) - Math.max(saved.y, d.workArea.y)
    const overlap = Math.max(w, 0) * Math.max(h, 0)
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { workArea: d.workArea, overlap }
  }
  return best
}

/**
 * Le misure SALVATE, riportate DENTRO gli schermi attuali (PURE): se cadono
 * fuori da tutti gli schermi si torna al default del display indicato; se
 * restano dentro si usano come sono, salvo i limiti (larghezza oltre il
 * massimo, oltre i bordi) che si riportano dentro.
 */
export function pipBoundsWithin(
  saved: PipRect,
  displays: Array<{ workArea: PipRect }>,
  fallbackWorkArea?: PipRect
): PipRect {
  const display = displayOf(saved, displays)
  if (!display) {
    const fallback = fallbackWorkArea
      ? displays.find((d) => displayOf({ ...fallbackWorkArea, x: fallbackWorkArea.x, y: fallbackWorkArea.y }, [d]))
      : null
    return defaultPipBounds((fallback ?? displays[0])!.workArea)
  }
  const area = display.workArea
  const width = Math.min(Math.max(saved.width, PIP_MIN_WIDTH), PIP_MAX_WIDTH)
  const height = Math.round(width / PIP_ASPECT)
  const x = Math.min(Math.max(saved.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(saved.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

/** La superficie di finestra che usa il manager (la finta nei test la registra). */
export interface PipWindowHandle {
  on(event: 'closed' | 'resize' | 'move', cb: () => void): void
  close(): void
  getBounds(): PipRect
  setAlwaysOnTop(flag: boolean, level: string): void
  isAlwaysOnTop(): boolean
  setAspectRatio(aspect: number): void
  setMinimumSize(w: number, h: number): void
  setMaximumSize(w: number, h: number): void
  webContents: {
    on(event: 'before-input-event', cb: (input: { type: string; key: string }) => void): void
  }
}

/** Le dipendenze del manager (tutte iniettate). */
export interface PipManagerDeps {
  /** il path del preload (lo stesso della finestra principale) */
  preloadPath(): string
  /** crea la finestra con le opzioni date e ci carica l'URL (adattatore Electron nel main) */
  createWindow(options: Record<string, unknown>, url: string): PipWindowHandle
  /** l'URL della rotta PiP per un bot: homun://app/#/pip/<agentId> (o il dev server) */
  urlFor(agentId: string): string
  /** gli schermi attuali (workArea di ciascuno) */
  displays(): Array<{ workArea: PipRect }>
  /** dove sta la finestra principale di Homun (null se chiusa) */
  homunBounds(): PipRect | null
  getSetting<T>(key: string, fallback: T): Promise<T>
  setSetting(key: string, value: unknown): Promise<void>
  /** l'evento `pip` con l'id del bot (o null): la card sa che deve scollegarsi (SV2) */
  emit(e: { type: 'pip'; agentId: string | null }): void
  /** «Riporta in Homun»: primo piano sulla finestra principale, scheda Computer */
  focusMain(agentId: string): void
  /** la finestra principale è visibile? (U3: staccare NON la nasconde mai — la sonda lo legge da pip:state) */
  mainVisible(): boolean
}

/**
 * Il gestore della PiP: UNA sola finestra per volta (staccarne un altro bot
 * SOSTITUISCE la prima), Esc chiude quando ha il focus, le misure si
 * ricordano in `ui.pip.bounds` (al movimento, con debounce, e alla chiusura).
 * Chiudere la finestra PRINCIPALE non la chiude: è una finestra indipendente.
 */
export class PipManager {
  private win: PipWindowHandle | null = null
  private agentId: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: PipManagerDeps) {}

  /** Il bot mostrato dalla PiP aperta (null se chiusa). */
  get current(): string | null {
    return this.agentId
  }

  /** Apre la PiP di un bot (sostituisce quella che c'è). */
  async open(agentId: string): Promise<void> {
    if (this.agentId === agentId && this.win) return // già aperta per quel bot
    // una sola PiP per volta: l'altra si SOSTITUISCE (la sua chiusura non
    // emette pip:null, la nuova arriva subito dopo con il suo id)
    const old = this.win
    this.win = null
    this.agentId = null
    old?.close()
    const displays = this.deps.displays()
    const homun = this.deps.homunBounds()
    const saved = await this.deps.getSetting<PipRect | null>(PIP_BOUNDS_SETTING, null).catch(() => null)
    const bounds = saved
      ? pipBoundsWithin(saved, displays, homun ?? undefined)
      : defaultPipBounds(
          (displays.find((d) => homun && displayOf(homun, [d])) ?? displays[0] ?? { workArea: { x: 0, y: 0, width: 1200, height: 800 } }).workArea
        )
    const win = this.deps.createWindow(pipWindowOptions(this.deps.preloadPath(), bounds), this.deps.urlFor(agentId))
    // U3 (fase prima-release): sempre sopra le altre app con floating, e
    // BASTA. setVisibleOnAllWorkspaces con visibleOnFullScreen trasformava il
    // processo in UIElementApplication (senza Dock né menu) e nascondeva le
    // finestre: Homun spariva staccando lo schermo. Scelta nel REPORT.
    win.setAlwaysOnTop(true, 'floating')
    // il rapporto 16:10 resta bloccato mentre si ridimensiona
    win.setAspectRatio(PIP_ASPECT)
    win.setMinimumSize(PIP_MIN_WIDTH, Math.round(PIP_MIN_WIDTH / PIP_ASPECT))
    win.setMaximumSize(PIP_MAX_WIDTH, Math.round(PIP_MAX_WIDTH / PIP_ASPECT))
    // Esc chiude la PiP quando ha il focus (il main la vede prima del renderer)
    win.webContents.on('before-input-event', (input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') this.close()
    })
    // le misure si ricordano (debounce: durante il trascinamento arrivano a
    // raffica); alla chiusura si salva SUBITO l'ultima posizione nota — la
    // finestra è già distrutta, non si può più leggere getBounds
    let lastBounds = bounds
    const remember = (value: PipRect): void => {
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null
        void this.deps.setSetting(PIP_BOUNDS_SETTING, value).catch(() => undefined)
      }, 250)
    }
    win.on('resize', () => { lastBounds = win.getBounds(); remember(lastBounds) })
    win.on('move', () => { lastBounds = win.getBounds(); remember(lastBounds) })
    win.on('closed', () => {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer)
        this.saveTimer = null
      }
      void this.deps.setSetting(PIP_BOUNDS_SETTING, lastBounds).catch(() => undefined)
      if (this.win === win) {
        this.win = null
        this.agentId = null
        this.deps.emit({ type: 'pip', agentId: null })
      }
    })
    this.win = win
    this.agentId = agentId
    this.deps.emit({ type: 'pip', agentId })
  }

  /** Chiude la PiP (bottone «Chiudi», Esc, sostituzione). */
  close(): void {
    this.win?.close()
  }

  /**
   * Lo stato della PiP (per la UI e per la sonda, che legge alwaysOnTop DAL
   * MAIN: è il main che ha creato la finestra).
   */
  state(): { open: boolean; agentId: string | null; alwaysOnTop: boolean; mainVisible: boolean } {
    return {
      open: this.win !== null,
      agentId: this.agentId,
      alwaysOnTop: this.win !== null && this.win.isAlwaysOnTop(),
      mainVisible: this.deps.mainVisible()
    }
  }

  /** «Riporta in Homun» (U3): UN gesto — chiude la PiP, la finestra principale
   *  in primo piano (la ricrea se chiusa) e apre la scheda Computer del bot. */
  focusMain(agentId: string): void {
    if (!agentId) return
    this.close()
    this.deps.focusMain(agentId)
  }

}

/** Il tipo dell'evento che il main broadcasta alle finestre (locale, non daemon). */
export type PipEvent = Extract<SandbotEvent, { type: 'pip' }>
