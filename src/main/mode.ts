// Modalità di avvio dell'app (fase rilascio, A1). Il daemon NON parte più
// come Node spoglio (ELECTRON_RUN_AS_NODE): è lo STESSO eseguibile Electron
// lanciato con --homun-daemon — così il fuse RunAsNode può essere spento
// nella build pubblicata (A4) senza perdere il daemon. Funzioni PURE:
// nessun import di Electron, testabili in vitest.
export const DAEMON_FLAG = '--homun-daemon'

/** True se la riga di comando chiede la modalità daemon (niente finestre). */
export function isDaemonMode(argv: string[]): boolean {
  return argv.includes(DAEMON_FLAG)
}

/** Directory dati esplicita (--data <dir>): resta accettata per i test. */
export function resolveDataDirArgv(argv: string[]): string | null {
  const i = argv.indexOf('--data')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]!
  return null
}

/**
 * La riga di comando di un processo è il NOSTRO daemon? (A1: le sonde E2E
 * cercano il processo proprio così). Il flag è untoken ambiguo-raro: vale
 * per l'app impacchettata (…/MacOS/Homun --homun-daemon) e per lo sviluppo
 * (…/Electron <repo> --homun-daemon).
 */
export function isDaemonCommandLine(cmd: string): boolean {
  return cmd.includes(DAEMON_FLAG)
}

/**
 * La riga di comando è un daemon VECCHIO (fase ≤16c: bundle daemon.js in
 * ELECTRON_RUN_AS_NODE)? Al primo avvio della 0.3 va fermato per fare posto
 * al nuovo (A1).
 */
export function isLegacyDaemonCommandLine(cmd: string): boolean {
  return !isDaemonCommandLine(cmd) && /\bdaemon\.js\b/.test(cmd)
}

export interface DaemonSpawnInput {
  execPath: string
  /** app impacchettata? (in dev serve il percorso dell'app come primo argomento) */
  isPackaged: boolean
  /** percorso dell'app (dev: la radice del repo col package.json) */
  appPath: string
  env: NodeJS.ProcessEnv
}

/**
 * Come lanciare il daemon (A1): l'eseguibile Electron dell'app con
 * --homun-daemon. MAI ELECTRON_RUN_AS_NODE — né negli argomenti né nell'env
 * (il fuse lo spegnerà nella build pubblicata). La directory dati NON si
 * passa: il daemon la ricava da userData (paths.ts) come la UI.
 */
export function daemonSpawnSpec(o: DaemonSpawnInput): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...o.env }
  delete env.ELECTRON_RUN_AS_NODE
  return {
    command: o.execPath,
    args: o.isPackaged ? [DAEMON_FLAG] : [o.appPath, DAEMON_FLAG],
    env
  }
}
