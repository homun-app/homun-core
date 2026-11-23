// P1 (fase primo-avvio): gli ORARI nel daemon.log. Il daemon scrive le sue
// righe con console.log/error e il prefisso [sandbotd] sullo stdout/stderr,
// che la UI redirige su data/daemon.log — ma senza orario: con main.log (che
// ha il prefisso ISO) non si potevano incrociare, e nel caso «Homun si apre e
// non si vede niente» il daemon parte ~0,2 s dopo la finestra: sapere COSA
// faceva in quei 200 ms è tutto.
//
// Qui il wrapper delle funzioni di console del daemon: una riga il cui primo
// argomento inizia con [sandbotd] prende davanti l'orario ISO, come main.log.
// Le righe degli ALTRI restano parola per parola com'erano (lo stdout dei
// server MCP, che il daemon lascia passare, non si tocca). PURA: la console e
// l'orologio si iniettano nei test. Lo installano gli entrypoint del daemon
// (src/main/index.ts in modalità --homun-daemon e src/daemon/index.ts), PRIMA
// della prima riga: il runtime resta Node puro.
export const DAEMON_LOG_PREFIX = '[sandbotd]'

export type DaemonConsole = Pick<Console, 'log' | 'info' | 'warn' | 'error'>

type Level = keyof DaemonConsole

const LEVELS: Level[] = ['log', 'info', 'warn', 'error']

/** True quando la chiamata è una riga del daemon: il primo argomento è la stringa che inizia con [sandbotd]. */
export function isDaemonLogLine(args: readonly unknown[]): args is [string, ...unknown[]] {
  return typeof args[0] === 'string' && (args[0] as string).startsWith(DAEMON_LOG_PREFIX)
}

/** La stessa chiamata con l'orario davanti alla riga del daemon (le altre restano identiche). */
export function withTimestamp(args: readonly unknown[], iso: string): unknown[] {
  if (!isDaemonLogLine(args)) return [...args]
  return [`${iso} ${args[0]}`, ...args.slice(1)]
}

/**
 * Installa il wrapper su console.log/info/warn/error (o sulla console data).
 * Torna la funzione che rimette le originali. Installato due volte non raddoppia
 * l'orario: la riga già prefissata non inizia più con [sandbotd].
 */
export function installDaemonLogTimestamps(
  target: DaemonConsole = console,
  now: () => number = () => Date.now()
): () => void {
  const originals = new Map<Level, DaemonConsole[Level]>()
  for (const level of LEVELS) {
    const original = target[level].bind(target)
    originals.set(level, target[level])
    target[level] = ((...args: unknown[]) => {
      original(...withTimestamp(args, new Date(now()).toISOString()))
    }) as DaemonConsole[Level]
  }
  return () => {
    for (const level of LEVELS) target[level] = originals.get(level)!
  }
}
