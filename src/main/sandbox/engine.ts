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
  /**
   * G2: l'init del container esistente. Facoltativo: i motori che leggono
   * TUTTI i fatti da un solo inspect (Apple, BAV2: reads.boxInspectArgv) non
   * lo implementano — Docker tiene i suoi quattro inspect -f di sempre.
   */
  boxInitCheck?(container: string): string[]
  boxMounts?(container: string): string[]
  /**
   * D7 (fase deleghe): il collegamento /workspace → /box/workspace nel
   * container in corsa (come root, idempotente) e il suo check — l'ensure lo
   * chiede a OGNI avvio del box, riusato o nuovo.
   */
  workspaceLink?(container: string): string[]
  workspaceLinkCheck?(container: string): string[]
  boxWritable(container: string): string[]
  containerImage?(container: string): string[]
  /** BR3: la RETE del box esistente (l'inspect da confrontare con networkNameOf). */
  containerNetwork?(container: string): string[]
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
  /**
   * BRB2 (fase browser-riavvio-box): i lock di Chromium (Singleton*) e di
   * xauth lasciati nel volume da un avvio precedente, COME 1001 e argv puri
   * — la UNICA chiave con cui il contratto BX5 cresce in questa fase.
   */
  browserLocksRm(container: string, owner: string): string[]
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

/** I fatti del box esistente che l'ensure decide (gli stessi di BoxEnsureFacts). */
export interface BoxReadFacts {
  /** G2/BAV4: il box è nato CON l'init (false → recreate 'senza-init'). */
  initOk: boolean
  /** punto 1: l'immagine del box è quella attesa; undefined = non si sa. */
  imageOk?: boolean
  /** l'immagine VECCHIA da togliere quando il box riparte con la nuova (BX3). */
  staleImage: string | null
  /** M4: il volume dei plugin montato RO; undefined = non si sa. */
  pluginsMountOk?: boolean
  /** P2: il volume del browser montato RW; undefined = non si sa. */
  browserMountOk?: boolean
  /** BR3: la rete è quella della modalità; undefined = non si sa. */
  networkOk?: boolean
}

/**
 * BAV2: le LETTURE del box PER MOTORE, PURA (argv da costruire, stdout da
 * leggere). Apple: `ls -a --format json` per l'esistenza, UN solo
 * `inspect` per TUTTI i fatti del box esistente, `volume ls --format json`
 * per i nomi, il JSON dell'`image inspect` per la dimensione. Docker non
 * le implementa: le sue letture restano i template Go dell'argv.
 */
export interface BoxEngineReads {
  /** l'argv dell'elenco dei container del motore. */
  psArgv(container: string): string[]
  /** il box c'è, dall'uscita dell'elenco (l'exit 0 lo ha già controllato chi chiama). */
  psExists(psStdout: string, container: string): boolean
  /** l'argv dell'inspect che porta TUTTI i fatti del box esistente. */
  boxInspectArgv(container: string): string[]
  /**
   * I fatti dall'uscita dell'inspect (PURO). null = inspect caduto o JSON
   * illeggibile: le regole di oggi (non si ricrea, salvo none che fallisce chiuso).
   */
  boxFacts(inspectStdout: string, opts: {
    /** il tag atteso dell'immagine (già normalizzato, com'è boxImage()). */
    expectedImage: string
    /** la build dell'immagine è riuscita (senza di lei imageOk resta ignoto). */
    imageKnown: boolean
    /** la rete che la modalità corrente richiede (networkNameOf). */
    networkName: string
  }): BoxReadFacts | null
  /** l'argv dell'elenco dei volumi del motore (la migrazione cerca i vecchi). */
  volumeLsArgv(): string[]
  /** i nomi dei volumi dall'uscita dell'elenco (null = illeggibile). */
  volumeNames(volumeLsStdout: string): string[] | null
  /** l'argv della dimensione dell'immagine. */
  imageSizeArgv(tag: string): string[]
  /** i byte dell'immagine intera dall'uscita dell'inspect (null = illeggibile). */
  imageSizeBytes(imageInspectStdout: string): number | null
  /**
   * CC2 (fase computer-card): lo stato del box dall'uscita dell'ELENCO dei
   * container (PURO, lo stesso argv di psArgv): 'running' | 'stopped' |
   * 'missing' | 'unknown' — Apple dal `status.state` del `ls -a --format
   * json`. Facoltativo: chi non c'è si legge con il ps + l'inspect
   * containerRunning (Docker, gli argv di oggi).
   */
  boxState?(lsStdout: string, container: string): 'running' | 'stopped' | 'missing' | 'unknown'
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
   * BAV2 (fase box-apple-cli-vera): le LETTURE del motore, quando parlano un
   * formato DAI NOMI PER RIGA di Docker (Apple: JSON puri — ls --format json,
   * UN solo inspect per tutti i fatti del box). Mancano → le letture di oggi
   * (ps + i quattro inspect -f dell'argv, i template Go di Docker che lì
   * sono validi). Podman e WSL2 le riuseranno.
   */
  reads?: BoxEngineReads
  /**
   * BR3 (fase box-rete): la rete che questo motore usa per la modalità —
   * Docker i nomi di Docker ('bridge' | 'none'), Apple le reti di Homun
   * ('homun-box' | 'homun-box-isolated'). PURA.
   */
  networkNameOf(network: 'bridge' | 'none'): string
  /**
   * BX2: il terreno del motore PRIMA del (ri)avvio del box, se il motore ne
   * ha uno (apple-container: la rete interna e il suo gateway). Il runner è
   * quello del box. Docker non lo implementa: nulla da preparare.
   * BR1 (fase box-rete): riceve la rete che la modalità corrente richiede —
   * apple-container prepara homun-box (bridge) o homun-box-isolated (none).
   */
  prepareNetwork?(run: (argv: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>, network: 'bridge' | 'none'): Promise<void>
  /**
   * BAV3 (fase box-apple-cli-vera): l'ensure IDEMPOTENTE di un volume, per
   * i motori la cui `volume create` NON lo è (Apple: esce 1 se esiste).
   * Leggi, crea se manca, RILEGGI se la create esce male («already exists»
   * o una corsa parallela). Mancano → la create diretta di oggi (Docker:
   * idempotente per davvero).
   */
  ensureVolume?(run: (argv: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>, name: string): Promise<void>
  /**
   * BR1 (fase box-rete): la difesa in profondità della modalità none, se il
   * motore ce l'ha (apple-container): le interfacce del box GIÙ come root e
   * la VERIFICA operstate. Lancia errore se non ci si riesce: il chiamante
   * fallisce CHIUSO (box rimosso, mai un box none senza verifica). Docker
   * non lo implementa: la rete none di Docker è del runtime, già chiusa.
   */
  isolateBoxNetwork?(run: (argv: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>): Promise<void>
  /**
   * BRR1 (fase box-rete-riavvio): la SOLA verifica operstate come root,
   * senza link down — l'ensure la chiama ANCHE quando il container si riusa:
   * un riavvio della VM (Mac riavviato, `container system stop/start`) è un
   * boot nuovo che riporta le interfacce SU, e la difesa deve tornare a
   * valere PRIMA di ogni exec del bot. Lancia se la verifica non passa (il
   * chiamante riprova con isolateBoxNetwork, poi fallisce chiuso).
   */
  isolationCheck?(run: (argv: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>): Promise<void>
  /**
   * BRB1 (fase browser-riavvio-box): l'argv che legge pid file e boot_id del
   * box in UN SOLO exec come 1001 (il pid file vive nella cartella 0700 di
   * pwuser): script sh -c COSTANTE, il path del pid file come argomento
   * posizionale — dati MAI composti in una shell, e i DUE valori (quello
   * scritto nel file e quello del box di adesso) mai letti da due exec
   * diversi. NON entra nell'argv map: il contratto BX5 cresce della sola
   * chiave browserLocksRm di BRB2; è un'operazione del motore, come
   * networkNameOf.
   */
  browserPidBootRead(container: string, pidFile: string): string[]
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
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { release } from 'node:os'
import { dockerEngine as dockerEngineImpl, dockerToolStatusInfo } from './docker-engine'
import { appleContainerEngine as appleContainerEngineImpl } from './apple-container-engine'
import { parseSystemStatusJson, parseSystemStatusTable, appleSystemStatusJsonArgv, appleSystemStatusArgv } from './apple-container-argv'
// OB6: l'override dei fatti macchina vale solo non impacchettata
import { isPackagedRuntime } from '../../shared/packaged'

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

/** L'esito della lettura di un file per la sonda (segue i symlink). */
export interface KernelFileStat {
  isFile: boolean
  size: number
}

/** La lettura di produzione: statSync SEGUE il symlink (null = non c'è). */
function defaultStatFile(path: string): KernelFileStat | null {
  try {
    const s = statSync(path)
    return { isFile: s.isFile(), size: s.size }
  } catch {
    return null
  }
}

/** Le dipendenze della sonda, sostituibili nei test (nessuno spawn, nessun fs). */
export const engineProbeDeps: {
  runCli: typeof defaultCliRunner
  /** OBV1: la lettura del file del kernel (il FOLLOW del symlink sta qui) */
  statFile: (path: string) => KernelFileStat | null
} = { runCli: defaultCliRunner, statFile: defaultStatFile }

/**
 * OBV1 (fase onboarding-b-dal-vivo): il kernel si rileva dal FILE, non dal
 * testo dello status (che non ne parla mai). C'è se
 * `<appRoot>/kernels/default.kernel-<arch>` esiste e, SEGUENDO il symlink,
 * il bersaglio è un file NON vuoto — è il layout vero dopo
 * `container system kernel set --recommended`:
 * `default.kernel-arm64 -> vmlinux-6.18.56-208-debug`. Senza appRoot o arch
 * (servizio spento, uscita senza percorsi) il kernel è SCONOSCIUTO → false:
 * si tratta come assente SOLO quando il servizio è acceso (per lo stato in
 * parole 'stopped' viene PRIMA di 'kernel-missing', quindi da spento non
 * decide niente). La lettura è iniettabile per i test.
 */
export function appleKernelFileOk(
  appRoot: string | null,
  arch: string | null,
  statFile: (path: string) => KernelFileStat | null = engineProbeDeps.statFile
): boolean {
  if (!appRoot || !arch) return false
  const st = statFile(join(appRoot, 'kernels', `default.kernel-${arch}`))
  return !!st && st.isFile && st.size > 0
}

/**
 * I FATTI della macchina per la scelta del motore (BX4): versione di macOS,
 * CLI di Apple (installata? servizio attivo? kernel?) e Docker (risponde?).
 * La CLI di Apple è quella del MOTORE (con SANDBOT_TEST_USER_DATA +
 * SANDBOT_TEST_CONTAINER_CLI è la CLI finta dei test, BX5); Docker si guarda
 * senza spawn (socket, come sempre).
 * OBV1 (fase onboarding-b-dal-vivo): lo status si chiede in JSON
 * (`system status --format json`); JSON non valido → si prova la TABELLA di
 * default. Il kernel NON si deduce più dal testo (che non ne parla mai): si
 * guarda il FILE `<appRoot>/kernels/default.kernel-<arch>`.
 */
export async function probeBoxEngineFacts(): Promise<BoxEngineFacts> {
  const cmd = appleContainerEngineImpl.command()
  let containerInstalled = false
  let containerServiceRunning = false
  let containerKernelOk = false
  const ver = await engineProbeDeps.runCli(cmd, ['--version'], 5_000).catch(() => null)
  if (ver && ver.exitCode === 0) {
    containerInstalled = true
    let parsed: ReturnType<typeof parseSystemStatusJson> = null
    const json = await engineProbeDeps.runCli(cmd, appleSystemStatusJsonArgv(), 5_000).catch(() => null)
    if (json && json.exitCode === 0) parsed = parseSystemStatusJson(json.stdout)
    if (!parsed) {
      // JSON non valido (o il flag rifiutato): la TABELLA di default
      const table = await engineProbeDeps.runCli(cmd, appleSystemStatusArgv(), 5_000).catch(() => null)
      if (table && table.exitCode === 0) parsed = parseSystemStatusTable(table.stdout)
    }
    if (parsed) {
      containerServiceRunning = parsed.running
      // il kernel: dal FILE, solo se il servizio è ACCESO (da spento è
      // sconosciuto e non decide: lo stato direbbe 'stopped' comunque)
      containerKernelOk = parsed.running ? appleKernelFileOk(parsed.appRoot, parsed.arch) : false
    }
  }
  const docker = dockerToolStatusInfo()
  // OB6 (fase onboarding-b): i fatti macchina si possono fingere SOLO nei
  // test e nelle sonde (mai nell'app impacchettata)
  const fake = machineFactsOverride()
  const facts: BoxEngineFacts = {
    platform: fake?.platform ?? process.platform,
    arch: fake?.arch ?? process.arch,
    macOsMajor: fake?.macOsMajor ?? (process.platform === 'darwin' ? macOsMajorFromDarwin(release()) : 0),
    containerInstalled,
    containerServiceRunning,
    containerKernelOk,
    dockerInstalled: docker.installed,
    dockerResponds: docker.running
  }
  // OB2: l'ULTIMA sonda si ricorda — la disponibilità del passo computer
  // della guida è sincrona e legge da qui
  lastFacts = facts
  return facts
}

/** OB2: i fatti dell'ultima sonda (null = mai sondata; la lettura è sincrona). */
let lastFacts: BoxEngineFacts | null = null
export function lastBoxEngineFacts(): BoxEngineFacts | null {
  return lastFacts
}

/** Solo per i test: azzera (o fissa) la cache dei fatti dell'ultima sonda. */
export function setLastBoxEngineFactsForTests(f: BoxEngineFacts | null): void {
  lastFacts = f
}

/**
 * OB6 (fase onboarding-b, PURa): l'override dei FATTI MACCHINA per le prove
 * (piattaforma, architettura, major di macOS) — la sonda della finestra fa
 * finta di essere su un Mac che regge il motore Apple, o su uno che NON lo
 * regge. Arriva SOLO da SANDBOT_TEST_FAKE_* ed è IGNORATO nell'app
 * impacchettata: la sonda dice sempre la verità della macchina vera.
 */
export function machineFactsOverride(
  env: NodeJS.ProcessEnv = process.env,
  packaged = isPackagedRuntime()
): { platform?: string; arch?: string; macOsMajor?: number } | null {
  if (packaged) return null
  if (env.SANDBOT_TEST_FAKE_PLATFORM === undefined && env.SANDBOT_TEST_FAKE_ARCH === undefined && env.SANDBOT_TEST_FAKE_MACOS_MAJOR === undefined) {
    return null
  }
  const major = Number(env.SANDBOT_TEST_FAKE_MACOS_MAJOR ?? '')
  return {
    ...(env.SANDBOT_TEST_FAKE_PLATFORM !== undefined ? { platform: env.SANDBOT_TEST_FAKE_PLATFORM } : {}),
    ...(env.SANDBOT_TEST_FAKE_ARCH !== undefined ? { arch: env.SANDBOT_TEST_FAKE_ARCH } : {}),
    ...(Number.isFinite(major) && major > 0 ? { macOsMajor: major } : {})
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
