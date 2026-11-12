// GC6.2 (fase guida-correzioni): il polling dello stato del modello
// integrato nella guida, come driver iniettabile (l'api FINTA nei test):
// il loop continua FINCHÉ si scarica, e se un download è ATTESO («Scarica»
// appena premuto) sopravvive anche alle letture ancora precedenti allo
// stato downloading del daemon — il difetto era che il vecchio effect
// partiva solo all'apertura del pannello e continuava solo se lo stato era
// GIÀ downloading: dopo localModelInstall() nessuno lo riavviava.
export interface LocalModelStatusLike {
  state: string
  progress?: { bytes: number; total: number } | null
  /** solo con state 'error': il messaggio dell'ultimo tentativo fallito */
  error?: string | null
  model: { sizeGb: number }
}

export type LocalModelUiState = 'idle' | 'downloading' | 'ready' | 'other' | 'error'

export interface LocalModelUi {
  state: LocalModelUiState
  pct: number
  sizeGb: number | null
  /** solo con state 'error' */
  error?: string
}

export interface LocalModelPollOpts {
  status(): Promise<LocalModelStatusLike>
  onUi(u: LocalModelUi): void
  delay(ms: number): Promise<void>
  isAlive(): boolean
  /**
   * un download è ATTESO (il bottone «Scarica» è appena partito con
   * started: true): le letture che non sono ancora downloading non fermano
   * il loop — lo stato del daemon gira poco dopo
   */
  expecting?(): boolean
  intervalMs?: number
  /** quante letture consecutive aspettarsi il download (default 5, ~5 s) */
  maxIdleReads?: number
}

/** La lettura dello stato → lo stato della UI del pannello (pura). */
export function localModelUiOf(st: LocalModelStatusLike): LocalModelUi {
  const sizeGb = st.model?.sizeGb ?? null
  const pct = st.progress && st.progress.total > 0
    ? Math.min(100, Math.round((st.progress.bytes / st.progress.total) * 100))
    : 0
  if (st.state === 'downloading') return { state: 'downloading', pct: Math.max(pct, 1), sizeGb }
  if (st.state === 'ready' || st.state === 'running') return { state: 'ready', pct: 100, sizeGb }
  if (st.state === 'error') return { state: 'error', pct: 0, sizeGb, ...(st.error ? { error: st.error } : {}) }
  if (st.state === 'not-installed' || st.state === 'idle') return { state: 'idle', pct: 0, sizeGb }
  return { state: 'other', pct, sizeGb }
}

/**
 * Il loop di polling: una lettura SUBITO, poi ogni intervalMs finché si
 * scarica; con expecting() anche oltre le letture precedenti al download
 * (max maxIdleReads). ready ed error fermano; l'eccezione dello status
 * diventa un errore DETTO (state 'error'), mai un loop muto.
 */
export async function runLocalModelPolling(opts: LocalModelPollOpts): Promise<void> {
  const interval = opts.intervalMs ?? 1_000
  const maxIdle = opts.maxIdleReads ?? 5
  let idleReads = 0
  for (;;) {
    let st: LocalModelStatusLike
    try {
      st = await opts.status()
    } catch {
      if (opts.isAlive()) opts.onUi({ state: 'error', pct: 0, sizeGb: null })
      return
    }
    if (!opts.isAlive()) return
    const ui = localModelUiOf(st)
    opts.onUi(ui)
    if (ui.state === 'ready' || ui.state === 'error') return
    if (st.state !== 'downloading') {
      // il download atteso può metterci qualche lettura a girare
      if (!(opts.expecting?.() && ++idleReads <= maxIdle)) return
    } else {
      idleReads = 0
    }
    await opts.delay(interval)
    if (!opts.isAlive()) return
  }
}
