// Modalità di avvio dell'app (fase rilascio, A1). Il daemon NON parte più
// come Node spoglio (ELECTRON_RUN_AS_NODE): è lo STESSO eseguibile Electron
// lanciato con --homun-daemon — così il fuse RunAsNode può essere spento
// nella build pubblicata (A4) senza perdere il daemon. Funzioni PURE:
// nessun import di Electron, testabili in vitest.
import { join } from 'node:path'
export const DAEMON_FLAG = '--homun-daemon'

/** True se la riga di comando chiede la modalità daemon (niente finestre). */
export function isDaemonMode(argv: string[]): boolean {
  return argv.includes(DAEMON_FLAG)
}

/**
 * Fase primo-avvio: l'app deve registrarsi come gestore di sandbot://? No
 * nelle prove (SANDBOT_TEST_USER_DATA): una copia impacchettata di prova, in
 * una cartella temporanea, prenderebbe il posto di quella vera FINCHÉ
 * l'app vera non si riavvia — e intanto la copia viene cancellata.
 */
export function registersProtocolClient(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.SANDBOT_TEST_USER_DATA
}

/** Il nome della cartella di Chromium del daemon, DENTRO userData. */
export const DAEMON_SESSION_DIR = 'daemon-session'

/**
 * P3.1 (fase primo-avvio): la cartella dei dati di Chromium del daemon
 * (sessionData: cache, Local Storage, i LOCK di LevelDB). UI e daemon sono
 * due processi Chromium dello stesso eseguibile e fino a qui aprivano gli
 * STESSI file in userData. Electron ≥ 20 stacca i dati di Chromium da
 * userData con app.setPath('sessionData', …) prima di whenReady; la cartella
 * resta DENTRO userData — che non si sposta, e con lui i dati di Homun.
 */
export function daemonSessionDataDir(userData: string): string {
  return join(userData, DAEMON_SESSION_DIR)
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

/**
 * RV1 (fase beta.2), PURA: la riga di comando di un processo parte
 * dall'eseguibile dato? `ps` stampa argv unito da spazi SENZA quoting, quindi
 * il confronto è per PREFISSO ESATTO sull'eseguibile (regge anche i percorsi
 * con spazi): `<exec> --homun-daemon` nell'app impacchettata,
 * `<exec> <repo> --homun-daemon` in sviluppo.
 */
export function daemonRunsFromExecutable(cmd: string, execPath: string): boolean {
  return cmd === execPath || cmd.startsWith(`${execPath} `)
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

/** Quanto deve passare fra due «rilancia la UI» del daemon (un doppio clic sul Dock). */
export const ACTIVATE_FORWARD_GAP_MS = 1_000

/**
 * P3.6 (fase primo-avvio): come il daemon RILANCIA la UI — l'inverso di
 * daemonSpawnSpec. Nell'app impacchettata lo stesso eseguibile SENZA
 * argomenti (è la UI); in sviluppo Electron col percorso dell'app. Mai il
 * flag del daemon. Se la UI gira già, la nuova istanza non prende il lock e
 * consegna il via alla prima (second-instance → showMainWindow).
 */
export function uiRelaunchSpec(o: DaemonSpawnInput): { command: string; args: string[] } {
  return { command: o.execPath, args: o.isPackaged ? [] : [o.appPath] }
}

/**
 * P3.6 (fase primo-avvio): l'activate del daemon diventa «rilancia la UI»,
 * una volta per ACTIVATE_FORWARD_GAP_MS (un doppio clic sul Dock non apre
 * due UI). Torna la funzione da chiamare a ogni activate: true se ha rilanciato.
 */
export function createActivateForwarder(launch: () => void, now: () => number = () => Date.now(), gapMs = ACTIVATE_FORWARD_GAP_MS): () => boolean {
  let last = Number.NEGATIVE_INFINITY
  return () => {
    const at = now()
    if (at - last < gapMs) return false
    last = at
    launch()
    return true
  }
}

/** La RPC host con cui il daemon dice alla UI CONNESSA «ti hanno attivata: portati davanti». */
export const ACTIVATE_HOST_METHOD = 'host.activate'

/**
 * P3.6: come il daemon inoltra l'activate. Con una UI connessa sul canale che
 * c'è già (RPC host.activate): NIENTE secondo processo — la sua uscita
 * disattiva l'app un istante dopo (misurato dal vivo) e la finestra torna
 * dietro. Senza UI si riparte dall'eseguibile.
 */
export function activateForwardRoute(uiConnected: boolean): 'host-call' | 'relaunch' {
  return uiConnected ? 'host-call' : 'relaunch'
}
