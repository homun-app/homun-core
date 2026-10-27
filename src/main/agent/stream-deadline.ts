// Scadenze dello stream LLM (fase 8, §3bis L11): 150 s per il primo token,
// 90 s di inattività tra due chunk → abort del SOLO stream (non del turno):
// notice "il modello non risponde", turno chiuso STOPPED, ripresa normale al
// messaggio successivo. I tempi sono configurabili (settings llm.firstTokenMs
// / llm.streamIdleMs) e il timer è iniettabile: nei test si usano valori
// piccolissimi con iteratori finti che non rispondono mai.
export interface StreamDeadlineOpts {
  firstTokenMs: number
  idleMs: number
}

export const DEFAULT_STREAM_DEADLINES: StreamDeadlineOpts = {
  firstTokenMs: 150_000,
  idleMs: 90_000
}

/** Orologio iniettabile (nei test: timer finti o valori minuscoli). */
export interface DeadlineTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}

const realTimers: DeadlineTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>)
}

/** Errore di scadenza: il loop lo riconosce e chiude il turno con la notice giusta. */
export class StreamDeadlineError extends Error {
  constructor(
    public readonly deadline: 'first-token' | 'idle',
    ms: number
  ) {
    const s = Math.round(ms / 1000)
    super(deadline === 'first-token' ? `nessun token entro ${s} s` : `stream inattivo da ${s} s`)
    this.name = 'StreamDeadlineError'
  }
}

/**
 * Il prossimo chunk dello stream con la scadenza giusta: prima del primo chunk
 * vale firstTokenMs, dopo ogni chunk si riarma idleMs. Scaduto → rifiuta con
 * StreamDeadlineError (e il timer viene sempre cancellato).
 */
export async function nextWithDeadline<T>(
  iter: AsyncIterator<T>,
  firstChunkSeen: boolean,
  opts: StreamDeadlineOpts,
  timers: DeadlineTimers = realTimers
): Promise<IteratorResult<T>> {
  const ms = firstChunkSeen ? opts.idleMs : opts.firstTokenMs
  let timer: unknown
  try {
    return await Promise.race([
      iter.next(),
      new Promise<never>((_, reject) => {
        timer = timers.setTimeout(() => reject(new StreamDeadlineError(firstChunkSeen ? 'idle' : 'first-token', ms)), ms)
      })
    ])
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer)
  }
}
