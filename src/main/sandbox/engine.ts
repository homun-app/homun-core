// Fase box-container (BX1): UN motore del box, DUE implementazioni — Docker
// (com'è oggi, byte per byte) e Apple `container` (macOS ≥ 26, chip Apple).
// Questo modulo tiene L'INTERFACCIA del motore, la SCELTA (pura) e gli STATI
// del motore Apple (puri): i due motori vivono nei loro moduli.
//
// La scelta del motore dipende dal setting `sandbox.engine`
// ('auto' | 'apple-container' | 'docker', default 'auto'): in `auto` vince
// apple-container quando la macchina lo regge ed è PRONTO, altrimenti docker
// se risponde, altrimenti NESSUN motore (si resta in host). Il valore storico
// `sandbox.mode` = 'docker' si legge come 'box': la modalità è «il computer
// dei bot», il motore è un dettaglio scelto qui.
//
// `sandbox.mode` resta 'host' | 'box' (in index.ts): 'box' quando un motore
// è pronto. QUESTO modulo non importa mai index.ts (index importa questo).
import { getSetting } from '../store/db'
import type { BoxLimits, DockerExecOptions, DockerKillSignal } from './docker-argv'

/** I due motori del box. */
export type BoxEngineId = 'docker' | 'apple-container'

export { CONTAINER_USER, BROWSER_USER, DEFAULT_BOX_LIMITS } from './docker-argv'

/** Le opzioni dell'exec nel box (le stesse di oggi: workdir + env). */
export type BoxExecOptions = DockerExecOptions

/**
 * I costruttori di argv PURI del motore, UNO per OGNI operazione che il box
 * usa oggi (create/run, exec — anche interattivi di terminale e schermo —,
 * cp nei due versi, inspect, ps, start/rm, volume, build) più le operazioni
 * dello spazio su disco (df, pruneSafe, removeImage, removeVolumes). Puri:
 * nessuno spawn, nessun filesystem — ogni motore costruisce i SUOI argv.
 */
export interface BoxEngineArgv {
  // ---- il contenitore del box ----
  ps(container: string): string[]
  start(container: string): string[]
  /** BX3 «Rimuovi» l'immagine: il box si FERMA prima. */
  stop(container: string): string[]
  boxCreate(container: string, volume: string, network: 'bridge' | 'none', limits: BoxLimits, image: string): string[]
  boxRm(container: string): string[]
  boxInitCheck(container: string): string[]
  boxMounts(container: string): string[]
  boxWritable(container: string): string[]
  containerImage(container: string): string[]
  ensureHome(container: string, agentId: string): string[]
  imageInspect(tag: string): string[]
  /** BX3: la dimensione in byte della NOSTRA immagine. */
  imageSize(tag: string): string[]
  build(tag: string, dockerfilePath: string, contextDir: string): string[]
  volumeLs(volume: string): string[]

  // ---- exec (comandi, background, MCP stdio) ----
  exec(container: string, command: string, opts?: BoxExecOptions): string[]
  execBackground(container: string, command: string, opts: BoxExecOptions, paths: { log: string; exit: string; pid: string }): string[]
  killGroup(container: string, pgid: number, signal: DockerKillSignal, user?: string): string[]
  statSize(container: string, path: string): string[]
  stdioMcp(opts: { workdir: string; command: string; args?: string[]; envKeys?: string[]; home?: string }): string[]

  // ---- file del box ----
  readFile(container: string, path: string): string[]
  writeFile(container: string, path: string): string[]
  listDir(container: string, path: string): string[]
  realpath(container: string, path: string): string[]
  findList(container: string, path: string): string[]
  readB64(container: string, path: string): string[]
  testPath(container: string, flag: '-f' | '-e' | '-d', path: string): string[]
  rmDir(boxPath: string, image: string): string[]
  /** cp box → Mac (BX1: l'argv che prima si assemblava inline). */
  cpFromBox(container: string, boxPath: string, macPath: string): string[]

  // ---- volumi dedicati e plugin ----
  pluginsVolumeCreate(): string[]
  pluginCopyCreate(helper: string, image: string): string[]
  pluginsMkdir(image: string, parentBoxPath: string): string[]
  pluginCp(localDir: string, helper: string, boxPath: string): string[]
  pluginsChown(image: string, boxPath: string): string[]
  pluginsChmod(image: string, boxPath: string): string[]
  pluginsRmHelper(helper: string): string[]

  // ---- il browser del bot ----
  browserVolumeCreate(): string[]
  browserRoot(image: string): string[]
  browserWritable(container: string): string[]
  browserOldProfileRm(container: string, owner: string): string[]
  browserMcp(agentId: string, proxyPort: number, opts?: { child?: boolean; owner?: string }): string[]
  browserReadFile(container: string, path: string): string[]
  browserReadB64(container: string, path: string): string[]
  browserWriteB64(container: string, path: string): string[]
  browserRmFile(container: string, path: string): string[]

  // ---- il desktop/schermo del bot ----
  screenControlVnc(owner: string, display: string): string[]
  screenControlPidRead(container: string, owner: string): string[]
  screenSocketReady(container: string, socketPath: string): string[]
  screenDisplayRead(container: string, owner: string): string[]
  screenBridge(socketPath: string): string[]
  xdotool(display: string, xauthority: string, args: string[]): string[]
  screenCapture(display: string, xauthority: string, owner: string, name: string): string[]
  screenGeometry(display: string, xauthority: string): string[]

  // ---- il terminale del bot ----
  terminal(owner: string): string[]
  termPidList(container: string, owner: string): string[]
  termPidClean(container: string, owner: string): string[]

  // ---- migrazione dai volumi vecchi ----
  boxChown(volume: string, image: string): string[]
  boxMigrate(oldVolume: string, agentId: string, image: string): string[]
  boxMarkerCheck(image: string): string[]
  boxMarkerWrite(image: string): string[]

  // ---- spazio su disco (BX3) ----
  df(): string[]
  /** La pulizia SICURA: una SEQUENZA di argv (mai immagine in uso, mai file dei bot). */
  pruneSafe(): string[][]
  removeImage(tag: string): string[]
  removeVolumes(names: string[]): string[]
}

/** Un motore del box: chi è, come si lancia un suo processo, i SUOI argv. */
export interface BoxEngine {
  readonly id: BoxEngineId
  /** L'eseguibile dei processi figli (docker: il PERCORSO risolto, fase A7). */
  command(): string
  /** L'env dei processi figli (docker: + DOCKER_HOST quando serve). */
  childEnv(env: NodeJS.ProcessEnv): Record<string, string>
  readonly argv: BoxEngineArgv
  /**
   * BX2: il terreno del motore PRIMA del (ri)avvio del box, se il motore ne
   * ha uno (apple-container: la rete interna e il suo gateway). Il runner è
   * quello del box. Docker non lo implementa: nulla da preparare.
   */
  prepareNetwork?(run: (argv: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>): Promise<void>
}

// ---- la scelta del motore (PURa) ----

export type SandboxEngineSetting = 'auto' | 'apple-container' | 'docker'

/** I fatti della macchina su cui si decide (tutti iniettabili nei test). */
export interface BoxEngineFacts {
  platform: string
  arch: string
  /** La major di macOS (26 = Tahoe); 0 se sconosciuta. */
  macOsMajor: number
  /** `container --version` risponde. */
  containerInstalled: boolean
  containerServiceRunning: boolean
  containerKernelOk: boolean
  dockerInstalled: boolean
  /** Docker risponde (CLI trovata E socket presente, come lo stato di oggi). */
  dockerResponds: boolean
}

/** Il motore Apple è USABILE su questa macchina (macOS ≥ 26 e chip Apple)? */
export function appleContainerSupported(facts: BoxEngineFacts): boolean {
  return facts.platform === 'darwin' && facts.arch === 'arm64' && facts.macOsMajor >= 26
}

/** Il motore Apple è PRONTO (usabile, installato, servizio attivo, kernel ok)? */
export function appleContainerReady(facts: BoxEngineFacts): boolean {
  return (
    appleContainerSupported(facts) &&
    facts.containerInstalled &&
    facts.containerServiceRunning &&
    facts.containerKernelOk
  )
}

/**
 * La scelta del motore (PURa). `auto`: apple-container se PRONTO, altrimenti
 * docker se RISPONDE, altrimenti NESSUN motore (null: si resta in host).
 * Esplicito `docker`: docker SEMPRE (è il motore di riserva scelto dall'utente
 * — l'errore chiaro di oggi se manca). Esplicito `apple-container`: solo se
 * USABILE e installato (spento o senza kernel → null: l'interfaccia dice come
 * accenderlo, intanto si resta in host).
 */
export function selectBoxEngine(setting: SandboxEngineSetting, facts: BoxEngineFacts): BoxEngineId | null {
  if (setting === 'docker') return 'docker'
  if (setting === 'apple-container') {
    return appleContainerSupported(facts) && facts.containerInstalled ? 'apple-container' : null
  }
  if (appleContainerReady(facts)) return 'apple-container'
  if (facts.dockerResponds) return 'docker'
  return null
}

// ---- gli stati del motore Apple (BX1.4, PURi: per Impostazioni e onboarding) ----

export type AppleEngineState = 'unsupported' | 'not-installed' | 'stopped' | 'kernel-missing' | 'ready'

/**
 * Lo stato del motore Apple in parole (ordine di colpa: prima la macchina,
 * poi l'installazione, poi il servizio, poi il kernel).
 */
export function appleContainerState(facts: BoxEngineFacts): AppleEngineState {
  if (!appleContainerSupported(facts)) return 'unsupported'
  if (!facts.containerInstalled) return 'not-installed'
  if (!facts.containerServiceRunning) return 'stopped'
  if (!facts.containerKernelOk) return 'kernel-missing'
  return 'ready'
}

/**
 * La major di macOS dal release di darwin (PURa): fino a darwin 24 vale
 * major−9 (24 → macOS 15); da darwin 25 (Tahoe) Apple numerò a anno: 25 → 26,
 * 27 → 28. Oltre la tabella nota → 0 (il confronto «≥ 26» resta falso, mai
 * ottimista su un macOS che non conosciamo).
 */
export function macOsMajorFromDarwin(release: string): number {
  const major = Number.parseInt(release.split('.')[0] ?? '', 10)
  if (!Number.isFinite(major) || major <= 0) return 0
  if (major >= 25) return major + 1
  if (major >= 20) return major - 9
  return 0
}

/** Il setting del motore (default 'auto'). */
export function sandboxEngineSetting(): SandboxEngineSetting {
  const v = getSetting<string>('sandbox.engine', 'auto')
  return v === 'apple-container' || v === 'docker' ? v : 'auto'
}

// ---- il motore ATTIVO ----
//
// La selezione in `auto` dipende da una sonda asincrona (container --version,
// system status): i punti d'uso sono spawn sincroni, quindi il risultato si
// MEMORIZZA (refreshActiveBoxEngine, chiamato dal boot del daemon e dalle RPC
// del motore). Mai sondato → docker, il comportamento di oggi.

import { execFile } from 'node:child_process'
import { release } from 'node:os'
import { dockerEngine as dockerEngineImpl, dockerToolStatusInfo } from './docker-engine'
import { appleContainerEngine as appleContainerEngineImpl } from './apple-container-engine'
import { parseSystemStatus } from './apple-container-argv'

/** I due motori (ri-esportati: i punti d'uso li prendono da qui). */
export const dockerEngine = dockerEngineImpl
export const appleContainerEngine = appleContainerEngineImpl

let activeAutoEngine: BoxEngineId | null = null

/** Solo per i test: fissa (o ripristina) l'esito della sonda dell'auto. */
export function setActiveEngineForTests(id: BoxEngineId | null): void {
  activeAutoEngine = id
}

/** L'esito fissato dell'ultima sonda dell'auto (null = mai sondata o nessun motore). */
export function cachedAutoEngine(): BoxEngineId | null {
  return activeAutoEngine
}

/**
 * Il motore attivo (sincrono). Esplicito → quel motore; auto → l'esito della
 * sonda (default docker). Con NESSUN motore in auto si torna comunque docker:
 * lo spawn fallisce con ENOENT e l'errore in parole resta quello di oggi — la
 * modalità effettiva la decide sandbox.mode, che resta 'host'.
 */
export function activeBoxEngine(): BoxEngine {
  const setting = sandboxEngineSetting()
  if (setting === 'docker') return dockerEngineImpl
  if (setting === 'apple-container') return appleContainerEngineImpl
  return activeAutoEngine === 'apple-container' ? appleContainerEngineImpl : dockerEngineImpl
}

/** Aggiorna l'esito della sonda dell'auto (chiamata dal daemon e dalle RPC). */
export function setCachedAutoEngine(id: BoxEngineId | null): void {
  activeAutoEngine = id
}

/** La pagina ufficiale delle release di Apple container (BX1.4: la mostra la UI). */
export const APPLE_CONTAINER_RELEASES_URL = 'https://github.com/apple/container/releases'

// ---- la SONDA dei fatti del motore (BX4: la RPC box:engine-status) ----

export interface CliRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

/** L'esecutore di produzione: execFile SENZA shell, con timeout. */
export function defaultCliRunner(file: string, argv: string[], timeoutMs: number): Promise<CliRunResult> {
  return new Promise((resolve) => {
    execFile(file, argv, { timeout: timeoutMs, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
      const exit = typeof e?.code === 'number' ? e.code : err ? null : 0
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: exit })
    })
  })
}

/** Le dipendenze della sonda, sostituibili nei test (nessuno spawn). */
export const engineProbeDeps: { runCli: typeof defaultCliRunner } = { runCli: defaultCliRunner }

/**
 * I FATTI della macchina per la scelta del motore (BX4): versione di macOS,
 * CLI di Apple (installata? servizio attivo? kernel?) e Docker (risponde?).
 * La CLI di Apple è quella del MOTORE (con SANDBOT_TEST_USER_DATA +
 * SANDBOT_TEST_CONTAINER_CLI è la CLI finta dei test, BX5); Docker si guarda
 * senza spawn (socket, come sempre).
 */
export async function probeBoxEngineFacts(): Promise<BoxEngineFacts> {
  const cmd = appleContainerEngineImpl.command()
  let containerInstalled = false
  let containerServiceRunning = false
  let containerKernelOk = false
  const ver = await engineProbeDeps.runCli(cmd, ['--version'], 5_000).catch(() => null)
  if (ver && ver.exitCode === 0) {
    containerInstalled = true
    const st = await engineProbeDeps.runCli(cmd, ['system', 'status'], 5_000).catch(() => null)
    if (st && st.exitCode === 0) {
      const parsed = parseSystemStatus(st.stdout)
      containerServiceRunning = parsed.running
      containerKernelOk = parsed.kernelOk
    }
  }
  const docker = dockerToolStatusInfo()
  return {
    platform: process.platform,
    arch: process.arch,
    macOsMajor: process.platform === 'darwin' ? macOsMajorFromDarwin(release()) : 0,
    containerInstalled,
    containerServiceRunning,
    containerKernelOk,
    dockerInstalled: docker.installed,
    dockerResponds: docker.running
  }
}

/**
 * La sonda completa e la MEMORIA del risultato per l'auto (BX1: i punti
 * d'uso sono sincroni; qui si aggiorna la cache dopo il sondaggio).
 */
export async function refreshAutoEngine(): Promise<{ facts: BoxEngineFacts; chosen: BoxEngineId | null }> {
  const facts = await probeBoxEngineFacts()
  const chosen = selectBoxEngine(sandboxEngineSetting(), facts)
  if (sandboxEngineSetting() === 'auto') setCachedAutoEngine(chosen)
  return { facts, chosen }
}
