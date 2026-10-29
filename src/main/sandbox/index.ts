// Sandbox di esecuzione: backend 'host' (spawn diretto, gate permessi) o
// 'docker' (UN container condiviso `sandbot-box` con volume `sandbot-box`
// montato su /box: /box/workspace è di tutti, /box/home/<agentId> è la home
// del bot — fase 11, punto 1; prima: un container per agente).
//
// §5.2: TUTTE le chiamate docker avvengono con spawn('docker', argv) — mai
// stringhe assemblate passate a una shell dell'host. Le operazioni file in
// modalità docker passano path come argv e contenuti via stdin; in modalità
// host usano fs/promises, non cat/heredoc.
//
// Fase 11 (punto 1): i path dei tool passano da resolveBoxPath (box-paths,
// puro) — relativi alla home del bot, `/workspace/…` alias della cartella
// comune, fuori dalla radice rifiutati (realpath: ../ e symlink esterni).
// Le scritture sono ATOMICHE (file temporaneo nella stessa cartella + rename).
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, readFileSync, realpathSync as realpathSyncHost } from 'node:fs'
import { readFile, writeFile, readdir, mkdir, rename, cp, copyFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { getSetting, dataDir, getAgent } from '../store/db'
import { resolveBoxPath } from './box-paths'
import {
  dockerExecArgv,
  dockerReadFileArgv,
  dockerWriteFileArgv,
  dockerListDirArgv,
  dockerPsArgv,
  dockerStartArgv,
  dockerBoxCreateArgv,
  dockerBoxChownArgv,
  dockerBoxMigrateArgv,
  dockerBoxMarkerCheckArgv,
  dockerBoxMarkerWriteArgv,
  dockerBoxInitCheckArgv,
  dockerBoxRmArgv,
  dockerBoxWritableArgv,
  dockerEnsureHomeArgv,
  boxNeedsRecreateForInit,
  boxEnsurePlan,
  boxCreateCheck,
  boxImageTag,
  dockerImageInspectArgv,
  dockerContainerImageArgv,
  dockerBuildArgv,
  BOX_IMAGE_BUILD_TIMEOUT_MS,
  type BoxEnsureFacts,
  dockerVolumeLsArgv,
  dockerPluginsVolumeCreateArgv,
  dockerBoxMountsArgv,
  boxHasPluginsMountRo,
  dockerClientEnv,
  BOX_CONTAINER,
  BOX_VOLUME,
  BOX_MOUNT,
  PLUGINS_VOLUME,
  boxHomePath,
  DEFAULT_BOX_LIMITS,
  type BoxLimits
} from './docker-argv'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
  trimmed: boolean
}

export interface ExecOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** Variabili d'ambiente aggiuntive (es. SANDBOT_SECRET_* risolte dal runtime). */
  env?: Record<string, string>
}

const MAX_OUTPUT_LINES = 10_000 // come l'originale (cap + stdout_trimmed)

export type SandboxMode = 'host' | 'docker'
export type SandboxNetwork = 'bridge' | 'none'

export function sandboxMode(): SandboxMode {
  return getSetting<SandboxMode>('sandbox.mode', 'host')
}

function sandboxNetwork(): SandboxNetwork {
  return getSetting<SandboxNetwork>('sandbox.network', 'bridge')
}

/**
 * Fase 11b (punto 2): il browser del bot esiste SOLO in modalità docker con
 * rete bridge (mai un browser sul Mac dell'utente); il flag di test del MCP
 * finto attiva il percorso anche in host per la verifica d'integrazione.
 */
export function browserSandboxOk(): boolean {
  return sandboxMode() === 'docker' && sandboxNetwork() === 'bridge'
}

/** Limiti condivisi del box, configurabili (punto 1: memoria 4g, cpu 2, pids 1024). */
export function boxLimits(): BoxLimits {
  return {
    memory: String(getSetting<string>('sandbox.boxMemory', DEFAULT_BOX_LIMITS.memory)),
    cpus: Number(getSetting<number>('sandbox.boxCpus', DEFAULT_BOX_LIMITS.cpus)),
    pids: Number(getSetting<number>('sandbox.boxPids', DEFAULT_BOX_LIMITS.pids))
  }
}

/**
 * Fase 11b (0c): il Dockerfile dell'immagine NOSTRA del box. Override di test
 * con SANDBOT_BOX_DOCKERFILE; nel pacchetto vive nelle extraResources
 * (process.resourcesPath/box); in dev nel repo (la cwd del daemon è la radice).
 */
export function boxDockerfilePath(): string {
  if (process.env.SANDBOT_BOX_DOCKERFILE) return process.env.SANDBOT_BOX_DOCKERFILE
  if (process.resourcesPath) {
    const packaged = join(process.resourcesPath, 'box', 'Dockerfile')
    if (existsSync(packaged)) return packaged
  }
  return join(process.cwd(), 'resources', 'box', 'Dockerfile')
}

/** Il tag dell'immagine del box, derivato dal CONTENUTO del Dockerfile. */
export function boxImage(): string {
  return boxImageTag(readFileSync(boxDockerfilePath(), 'utf8'))
}

/**
 * Fase 11 (residuo 0d + §3bis L1): la radice del BOX CONDIVISO vive nella
 * directory DATI (<dir dati>/box), non più nella home dell'utente: il box è
 * un computer dei bot, non un file dell'utente, e la directory dati è già
 * quella dell'app (iniettabile nei test: radice mai nella home reale).
 * Struttura (punto 1): <radice>/workspace (comune a tutti i bot) e
 * <radice>/home/<agentId> (la home di ciascun bot).
 */
export function boxRoot(): string {
  const root = join(dataDir(), 'box')
  mkdirSync(join(root, 'workspace'), { recursive: true })
  return root
}

/**
 * Fase 12 (punto 1): il PROPRIETARIO delle risorse del box. Per un sottoagente
 * (riga agents con parent_id) è il PADRE, per gli altri l'id stesso: è la
 * funzione unica che sta in ogni punto che costruisce una home o un path del
 * box — così il figlio lavora nella home del padre (i file sono condivisi,
 * come in Grok e in Claude Code).
 */
export function boxOwnerOf(agentId: string): string {
  try {
    return getAgent(agentId)?.parentId ?? agentId
  } catch {
    // store non disponibile (boot freddo): l'id stesso, il chiamante deciderà
    return agentId
  }
}

/** Fase 12: la riga è un sottoagente (bot figlio)? Serve a pid file e orfani del browser. */
export function isSubagent(agentId: string): boolean {
  try {
    return getAgent(agentId)?.parentId != null
  } catch {
    return false
  }
}

/** La home del bot dentro il box condiviso (cwd predefinita dei suoi comandi); per un figlio è quella del padre. */
export function boxDir(agentId: string): string {
  const dir = join(boxRoot(), 'home', boxOwnerOf(agentId))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Il tetto di righe dell'output dei comandi (come l'originale). */
export function capOutput(text: string): { text: string; trimmed: boolean } {
  const lines = text.split('\n')
  if (lines.length <= MAX_OUTPUT_LINES) return { text, trimmed: false }
  return { text: lines.slice(0, MAX_OUTPUT_LINES).join('\n'), trimmed: true }
}

interface SpawnOptions extends ExecOptions {
  cwd?: string
  /** Contenuto da scrivere sul stdin del processo (scrittura file via stdin). */
  input?: string
}

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
}

/** Esegue un processo SENZA shell: file + argv array, output catturato, timeout/abort. */
function runProcess(file: string, argv: string[], opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 120_000
    const signal = opts.signal ?? new AbortController().signal
    const child = spawn(file, argv, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    const onAbort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    if (opts.input !== undefined) {
      child.stdin.on('error', () => undefined) // EPIPE se il processo esce prima
      child.stdin.end(opts.input)
    } else {
      child.stdin.end()
    }
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 2_000_000) out += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 2_000_000) err += d.toString()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ stdout: out, stderr: `${err}${e.message}`, exitCode: null, signal: null })
    })
    child.on('close', (code, sig) => {
      clearTimeout(timer)
      resolve({ stdout: out, stderr: err, exitCode: code, signal: sig })
    })
  })
}

/** Esecuzione in modalità host: shell dell'utente dentro la home del bot nel box condiviso (gate permessi a monte). */
async function execHost(command: string, cwd: string, opts: ExecOptions): Promise<ExecResult> {
  const sh = process.env.SHELL || '/bin/sh' // come l'originale: spawn(env.SHELL ?? /bin/sh)
  const r = await runProcess(sh, ['-c', command], { ...opts, cwd })
  const o = capOutput(r.stdout)
  const e = capOutput(r.stderr)
  return { stdout: o.text, stderr: e.text, exitCode: r.exitCode, signal: r.signal, trimmed: o.trimmed || e.trimmed }
}

async function docker(argv: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  await ensureBoxContainer()
  return dockerRunner(argv, opts)
}

/**
 * Il runner dei comandi docker del modulo (argv puri): iniettabile nei test,
 * così la sequenza container→home→exec e la memoria delle home si provano
 * senza Docker (H2).
 */
export type DockerRunner = (argv: string[], opts?: SpawnOptions) => Promise<SpawnResult>

let dockerRunner: DockerRunner = (argv, opts) => runProcess('docker', argv, opts ?? {})

/** Solo per i test: sostituisce (o ripristina) il runner dei comandi docker. */
export function setDockerRunnerForTests(runner: DockerRunner | null): void {
  dockerRunner = runner ?? ((argv, opts) => runProcess('docker', argv, opts ?? {}))
}

/** Solo per i test: azzera la memoria delle home assicurate (container fresco). */
export function resetBotHomesForTests(): void {
  ensuredBotHomes.clear()
}

// H2: le home già create nel container, ricordate per agente — il mkdir avviene
// UNA volta per container, non prima di ogni exec
const ensuredBotHomes = new Set<string>()

/**
 * H2: la home del bot ESISTE prima di ogni exec in docker (il chiamante ha
 * già garantito il container con ensureBoxContainer). Il one-shot di init
 * crea /box/workspace e /box/home ma non le home dei SINGOLI bot, e ogni exec
 * (run-command, lancio in background) usa `-w /box/home/<agentId>`: senza
 * home l'OCI runtime rifiuta il chdir e il comando non parte. Un `mkdir -p`
 * argv puro per agente, ricordato in memoria; il ricordo si azzera quando
 * ensureBoxContainer crea o ricrea il container.
 */
export async function ensureBotHome(agentId: string): Promise<void> {
  if (sandboxMode() !== 'docker') return
  // fase 12 (punto 1): la home di un FIGLIO è quella del padre
  const owner = boxOwnerOf(agentId)
  if (ensuredBotHomes.has(owner)) return
  const r = await dockerRunner(dockerEnsureHomeArgv(BOX_CONTAINER, owner), { timeoutMs: 30_000 })
  if (r.exitCode !== 0) {
    throw new Error(`creazione della home ${boxHomePath(owner)} nel container fallita: ${r.stderr || `exit ${r.exitCode}`}`)
  }
  ensuredBotHomes.add(owner)
}

/** Esecuzione nel container condiviso: argv, senza shell dell'host; ogni exec gira nella home del bot con la sua HOME. */
async function execDocker(agentId: string, command: string, opts: ExecOptions): Promise<ExecResult> {
  // H2: -w punta alla home del bot — la home esiste PRIMA dell'exec (un'unica
  // catena ensure: container, poi home, poi il comando).
  // Fase 12 (punto 1): la home è quella del PROPRIETARIO (il padre di un figlio)
  await ensureBoxContainer()
  await ensureBotHome(agentId)
  const home = boxHomePath(boxOwnerOf(agentId))
  const env = { HOME: home, ...(opts.env ?? {}) }
  const r = await dockerRunner(dockerExecArgv(BOX_CONTAINER, command, { workdir: home, env }), {
    ...opts,
    // F2: nell'env del processo docker sull'HOST restano il daemon + i SOLI
    // segreti: il client docker usa HOME sua per trovare ~/.docker (contesti,
    // socket di Docker Desktop/Colima); HOME del bot e le altre variabili non
    // segrete viaggiano col VALORE nell'argv (-e KEY=VALORE)
    env: dockerClientEnv(env)
  })
  const o = capOutput(r.stdout)
  const e = capOutput(r.stderr)
  return { stdout: o.text, stderr: e.text, exitCode: r.exitCode, signal: r.signal, trimmed: o.trimmed || e.trimmed }
}

/**
 * Esegue ARGV PURI nel container condiviso (F6): per i path che arrivano dal
 * modello (es. `stat -c %s -- <path>`) — nessuna shell, niente interpolazione.
 */
export async function runDockerArgv(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const r = await docker(argv, opts)
  const o = capOutput(r.stdout)
  const e = capOutput(r.stderr)
  return { stdout: o.text, stderr: e.text, exitCode: r.exitCode, signal: r.signal, trimmed: o.trimmed || e.trimmed }
}

/**
 * ARGV puri docker SENZA la catena ensure del container (punto 2): per i
 * controlli best-effort al boot (uccidere gli orfani del browser) — se il
 * container non c'è, l'exec fallisce e il chiamante ignora.
 */
export async function runDockerRaw(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const r = await dockerRunner(argv, opts)
  const o = capOutput(r.stdout)
  const e = capOutput(r.stderr)
  return { stdout: o.text, stderr: e.text, exitCode: r.exitCode, signal: r.signal, trimmed: o.trimmed || e.trimmed }
}

// H1: l'errore chiaro del controllo di scrivibilità si RICORDA — dopo l'unica
// ricreazione fallita ogni operazione fallisce subito, senza ripetere la
// catena ps/inspect/rm/create a ogni write-file (si azzera al riavvio).
let boxNotWritableError: string | null = null

/**
 * Punto 1: la build dell'immagine del box, SINGLE-FLIGHT — se più bot la
 * chiedono insieme (o il tick e un exec), una sola build gira e tutti ne
 * aspettano l'esito. Prima di partire manda un notice al bot principale:
 * "preparo il computer dei bot, una volta sola, qualche minuto".
 */
let boxImageBuild: Promise<boolean> | null = null

/** Il notice al bot principale prima della build (una volta per build). */
function notifyBoxImageBuild(): void {
  void (async () => {
    try {
      const { listAgents, getSetting, appendEntry } = await import('../store/db')
      const { mainAgentOf } = await import('../../daemon/presence')
      const main = mainAgentOf(listAgents(), getSetting<string | null>('mainAgentId', null))
      if (!main) return
      appendEntry({
        agentId: main.id, kind: 'notice', role: 'system',
        content: 'Preparo il computer dei bot (immagine del box con il browser): una volta sola, qualche minuto. I bot riprendono appena è pronta.'
      })
    } catch {
      // notice best-effort: la build parte comunque
    }
  })()
}

/**
 * Punto 1: se l'immagine del box manca, la COSTRUISCE (timeout 20 minuti,
 * single-flight, notice al bot principale). false = build fallita (l'errore
 * lo dice il chiamante, che sa se il container vecchio esiste ancora).
 */
function ensureBoxImage(): Promise<boolean> {
  if (!boxImageBuild) {
    boxImageBuild = (async () => {
      const tag = boxImage()
      const has = await dockerRunner(dockerImageInspectArgv(tag), { timeoutMs: 15_000 })
      if (has.exitCode === 0) return true
      notifyBoxImageBuild()
      const dockerfile = boxDockerfilePath()
      const build = await dockerRunner(dockerBuildArgv(tag, dockerfile, dirname(dockerfile)), { timeoutMs: BOX_IMAGE_BUILD_TIMEOUT_MS })
      if (build.exitCode !== 0) {
        console.error(`[sandbox] build dell'immagine del box (${tag}) fallita: ${(build.stderr || `exit ${build.exitCode}`).slice(0, 500)}`)
        return false
      }
      return true
    })().finally(() => {
      // la corsa è chiusa: la PROSSIMA richiesta ricontrolla l'immagine
      boxImageBuild = null
    })
  }
  return boxImageBuild
}

/**
 * Il container UNICO del box condiviso (punto 1): come il vecchio
 * ensureContainer per agente, ma con volume `sandbot-box` montato su /box e
 * limiti condivisi configurabili. H1: dopo ogni start un controllo argv puro
 * `test -w /box/workspace` — un volume di root (container nato senza :nocopy)
 * si scopre qui, con UNA ricreazione che ripassa dal one-shot di init, e poi
 * con l'errore chiaro: mai permessi negati sparsi a ogni write-file.
 * Punto 1: l'immagine è NOSTRA — manca → build single-flight; il container
 * esiste con un'immagine DIVERSA → ricreazione (solo il container, volume mai
 * toccato). Build fallita col container che esiste ancora → si PROSEGUE col
 * vecchio (i tool senza browser continuano a funzionare); senza container →
 * errore chiaro.
 */
export async function ensureBoxContainer(): Promise<void> {
  if (sandboxMode() !== 'docker') return
  if (boxNotWritableError) throw new Error(boxNotWritableError)
  // punto 1: l'immagine del box esiste (o viene costruita) PRIMA di tutto
  const image = boxImage()
  const imageOk = await ensureBoxImage()
  const ps = await dockerRunner(dockerPsArgv(BOX_CONTAINER), { timeoutMs: 15_000 })
  const exists = ps.exitCode === 0 && ps.stdout.trim().split('\n').includes(BOX_CONTAINER)
  if (!imageOk && !exists) {
    throw new Error(`build dell'immagine del box (${image}) fallita: guarda i log del daemon (docker build); il Dockerfile è ${boxDockerfilePath()}`)
  }
  const facts: BoxEnsureFacts = { exists, initOk: true }
  if (exists) {
    // G2: un container nato PRIMA di --init non raccoglie gli zombie (PID 1 è
    // `sleep infinity`) e con --pids-limit condiviso li accumula a ogni comando
    // in background: si ricrea. Si rimuove SOLO il container — il volume con i
    // dati dei bot non si tocca MAI. Inspect fallito/output inatteso: si tiene
    // il container che funziona (la ricreazione è ottimale, non vitale).
    const init = await dockerRunner(dockerBoxInitCheckArgv(BOX_CONTAINER), { timeoutMs: 15_000 })
    facts.initOk = !(init.exitCode === 0 && boxNeedsRecreateForInit(init.stdout))
    if (facts.initOk) {
      // punto 1: container nato con un'IMMAGINE DIVERSA (Dockerfile cambiato)
      // → stessa regola di G2/H1. L'inspect fallito NON ricrea (imageOk resta
      // undefined): un falso positivo fermerebbe i bot senza bisogno; con la
      // build fallita non si ricrea nemmeno (l'immagine nuova non c'è).
      if (imageOk) {
        const img = await dockerRunner(dockerContainerImageArgv(BOX_CONTAINER), { timeoutMs: 15_000 })
        facts.imageOk = img.exitCode === 0 ? img.stdout.trim() === image : undefined
      }
      // M4: container nato PRIMA del volume dei plugin → niente mount
      // /plugins:ro → si ricrea (solo il container; il volume /box resta
      // intatto). Inspect fallito: come sopra, NON si ricrea
      const mounts = await dockerRunner(dockerBoxMountsArgv(BOX_CONTAINER), { timeoutMs: 15_000 })
      facts.pluginsMountOk = mounts.exitCode === 0 ? boxHasPluginsMountRo(mounts.stdout) : undefined
      const start = await dockerRunner(dockerStartArgv(BOX_CONTAINER), { timeoutMs: 30_000 })
      if (start.exitCode !== 0) throw new Error(`docker start fallito: ${start.stderr}`)
      const w = await dockerRunner(dockerBoxWritableArgv(BOX_CONTAINER), { timeoutMs: 15_000 })
      facts.writable = w.exitCode === 0
    }
  }
  const plan = boxEnsurePlan(facts)
  if (plan.kind === 'use') return
  // N1 (fase 13 correzioni 3): il MOTIVO di ogni ricreazione una riga nel log
  // del daemon (stdout/stderr finiscono in data/daemon.log) — un ciclo di
  // ricreazioni a ogni comando si vede nei log invece di passare inosservato
  if (plan.kind === 'recreate') {
    console.error(`[sandbox] ricreazione del container ${BOX_CONTAINER}: ${plan.reason}`)
  }
  // H2: il container sta per essere creato o ricreato — le home assicurate
  // finora non contano più: il ricordo si rifa dal container vero
  ensuredBotHomes.clear()
  if (plan.kind === 'recreate') {
    const rm = await dockerRunner(dockerBoxRmArgv(BOX_CONTAINER), { timeoutMs: 30_000 })
    if (rm.exitCode !== 0) throw new Error(`rimozione del container (${plan.reason}) fallita: ${rm.stderr}`)
  }
  // M4: il volume DEDICATO dei plugin esiste PRIMA del create che lo monta
  // (volume create è idempotente: lo crea solo se manca)
  const pvc = await dockerRunner(dockerPluginsVolumeCreateArgv(), { timeoutMs: 15_000 })
  if (pvc.exitCode !== 0) throw new Error(`creazione del volume ${PLUGINS_VOLUME} non riuscita: ${pvc.stderr}`)
  // creazione (prima volta o ricreazione G2/H1): il one-shot rende il volume
  // NON vuoto (workspace e home) e lo consegna all'utente del container; il
  // mount :nocopy del create non dipende dal copy-up di docker
  // 0c: creazione e one-shot con l'immagine NOSTRA del box (tag dal Dockerfile)
  const chown = await dockerRunner(dockerBoxChownArgv(BOX_VOLUME, image), { timeoutMs: 60_000 })
  if (chown.exitCode !== 0) throw new Error(`init volume fallito: ${chown.stderr}`)
  const create = await dockerRunner(dockerBoxCreateArgv(BOX_CONTAINER, BOX_VOLUME, sandboxNetwork(), boxLimits(), image), { timeoutMs: 60_000 })
  if (create.exitCode !== 0) throw new Error(`docker create fallito: ${create.stderr}`)
  const start = await dockerRunner(dockerStartArgv(BOX_CONTAINER), { timeoutMs: 30_000 })
  if (start.exitCode !== 0) throw new Error(`docker start fallito: ${start.stderr}`)
  const w = await dockerRunner(dockerBoxWritableArgv(BOX_CONTAINER), { timeoutMs: 15_000 })
  const check = boxCreateCheck(w.exitCode === 0)
  if (!check.ok) {
    boxNotWritableError = check.error
    throw new Error(check.error)
  }
}

export async function execCommand(agentId: string, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  if (sandboxMode() === 'docker') return execDocker(agentId, command, opts)
  return execHost(command, boxDir(agentId), opts)
}

// ---- operazioni file (passano sempre dal backend attivo e dai confini del box) ----

/** Il path di un tool risolto e validato per la modalità attiva (host: fs reale; docker: forma). */
function checkedBoxPath(agentId: string, path: string): string {
  // fase 12 (punto 1): i confini sono quelli della home del PROPRIETARIO —
  // la home condivisa col padre (boxDir e boxHomeOf fanno già il redirect)
  const owner = boxOwnerOf(agentId)
  if (sandboxMode() === 'docker') {
    // in docker il filesystem sta nel container: solo controllo di FORMA
    // (realpath non è disponibile senza un exec in più per operazione)
    const r = resolveBoxPath(path, BOX_MOUNT, boxHomePath(owner), (p) => p)
    if (!r.ok) throw new Error(r.reason)
    return r.abs!
  }
  const r = resolveBoxPath(path, boxRoot(), boxDir(agentId), realpathSyncHost)
  if (!r.ok) throw new Error(r.reason)
  return r.abs!
}

/**
 * Fase 12 (punto 3): un path del box è VALIDO per la home di questo agente
 * (come lo controllerebbe write-file), senza toccare il filesystem? Serve alla
 * validazione di report_path in wake_parent.
 */
export function validBoxPathOf(agentId: string, path: string): boolean {
  try {
    checkedBoxPath(agentId, path)
    return true
  } catch {
    return false
  }
}

export async function readFileInBox(agentId: string, path: string): Promise<string> {
  const abs = checkedBoxPath(agentId, path)
  if (sandboxMode() === 'docker') {
    const r = await docker(dockerReadFileArgv(BOX_CONTAINER, abs), { timeoutMs: 30_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr || `read fallito (${path})`)
    return r.stdout
  }
  return readFile(abs, 'utf8')
}

export async function writeFileInBox(agentId: string, path: string, content: string): Promise<void> {
  const abs = checkedBoxPath(agentId, path)
  if (sandboxMode() === 'docker') {
    // path come argomento posizionale, contenuto via stdin: byte per byte
    // identico, scritto su temporaneo e rinominato (atomico, come in host)
    const r = await docker(dockerWriteFileArgv(BOX_CONTAINER, abs), { timeoutMs: 30_000, input: content })
    if (r.exitCode !== 0) throw new Error(r.stderr || `write fallito (${path})`)
    return
  }
  // scrittura ATOMICA (punto 1): temporaneo nella STESSA cartella, poi rename —
  // un altro bot non legge mai un file scritto a metà
  await mkdir(dirname(abs), { recursive: true })
  const tmp = join(dirname(abs), `.${basename(abs)}.sandbot-tmp-${randomUUID().slice(0, 8)}`)
  await writeFile(tmp, content)
  await rename(tmp, abs)
}

export async function listDirectoryInBox(agentId: string, path: string): Promise<string> {
  const abs = checkedBoxPath(agentId, path)
  if (sandboxMode() === 'docker') {
    const r = await docker(dockerListDirArgv(BOX_CONTAINER, abs), { timeoutMs: 30_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr || `ls fallito (${path})`)
    return r.stdout
  }
  const entries = await readdir(abs, { withFileTypes: true })
  return entries.map((e) => `${e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : '-'} ${e.name}`).join('\n')
}

// ---- fase 11 (punto 4): copia di file tra Mac e box (byte-exact) ----

/**
 * Copia un file dal Mac DENTRO il box (host: fs copyFile; docker: `docker cp`,
 * argv puro). I confini del path del box li ha già validati il chiamante.
 */
export async function copyMacIntoBox(agentId: string, macPath: string, boxAbsPath: string): Promise<void> {
  if (sandboxMode() === 'docker') {
    const r = await runProcess('docker', ['cp', macPath, `${BOX_CONTAINER}:${boxAbsPath}`], { timeoutMs: 120_000 })
    if (r.exitCode !== 0) throw new Error(`docker cp fallito: ${r.stderr}`)
    return
  }
  await mkdir(dirname(boxAbsPath), { recursive: true })
  await copyFile(macPath, boxAbsPath)
}

/**
 * Copia un file dal box al Mac (host: fs copyFile; docker: `docker cp`).
 * La destinazione sul Mac la decide il chiamante (già validata dalla policy).
 */
export async function copyBoxOntoMac(agentId: string, boxAbsPath: string, macPath: string): Promise<void> {
  if (sandboxMode() === 'docker') {
    const r = await runProcess('docker', ['cp', `${BOX_CONTAINER}:${boxAbsPath}`, macPath], { timeoutMs: 120_000 })
    if (r.exitCode !== 0) throw new Error(`docker cp fallito: ${r.stderr}`)
    return
  }
  await mkdir(dirname(macPath), { recursive: true })
  await copyFile(boxAbsPath, macPath)
}

// ---- migrazione una tantum dal layout vecchio (punto 1) ----

/** Il marker dell'idempotenza, dentro il box (host: file reale; docker: /box/.migrated-v1). */
const HOST_MIGRATION_MARKER = '.migrated-v1'

export interface BoxMigration {
  migrated: Array<{ agentId: string; from: string; to: string }>
  alreadyDone: boolean
  /** F9: copie FALLITE — niente marker, si riprovano al prossimo avvio */
  failed: Array<{ agentId: string; from: string }>
}

/**
 * Migrazione del layout VECCHIO (un box per agente) a quello condiviso, SENZA
 * cancellare nulla (punto 1): host copia `~/SandBot/<agentId>/box` nella nuova
 * home `<dir dati>/box/home/<agentId>`; docker copia i vecchi volumi
 * `sandbot-<agentId>-box` in `/box/home/<agentId>` con container one-shot.
 * Gli originali restano dove sono: la cancellazione la decide l'utente.
 * Idempotente: un marker nel box, scritto SOLO se TUTTE le copie sono riuscite
 * (F9) — una copia fallita finisce in `failed` e si riprova al prossimo avvio.
 * Le dipendenze sono iniettabili per i test (nessuna home reale).
 */
export async function migrateLegacyBoxes(
  agents: ReadonlyArray<{ id: string }>,
  deps: { legacyRoot?: string; runDocker?: (argv: string[]) => Promise<{ exitCode: number | null; stdout: string }> } = {}
): Promise<BoxMigration> {
  const root = boxRoot()
  if (sandboxMode() === 'docker') {
    const defaultRun = (argv: string[]): Promise<{ exitCode: number | null; stdout: string }> =>
      runProcess('docker', argv, { timeoutMs: 120_000 })
    const run = deps.runDocker ?? defaultRun
    const image = boxImage()
    const check = await run(dockerBoxMarkerCheckArgv(image))
    if (check.exitCode === 0) return { migrated: [], alreadyDone: true, failed: [] }
    const migrated: Array<{ agentId: string; from: string; to: string }> = []
    const failed: Array<{ agentId: string; from: string }> = []
    for (const a of agents) {
      const oldVolume = `sandbot-${a.id}-box`
      const ls = await run(dockerVolumeLsArgv(oldVolume))
      if (ls.exitCode === 0 && ls.stdout.trim().split('\n').includes(oldVolume)) {
        const copy = await run(dockerBoxMigrateArgv(oldVolume, a.id, image))
        if (copy.exitCode === 0) migrated.push({ agentId: a.id, from: `volume docker ${oldVolume}`, to: `/box/home/${a.id}` })
        else failed.push({ agentId: a.id, from: `volume docker ${oldVolume}` })
      }
    }
    // F9: il marker SOLO se tutto è andato bene — con copie fallite la
    // migrazione di quel bot va ritentata al prossimo avvio
    if (!failed.length) await run(dockerBoxMarkerWriteArgv(image))
    return { migrated, alreadyDone: false, failed }
  }
  const legacyRoot = deps.legacyRoot ?? join(homedir(), 'SandBot')
  const marker = join(root, HOST_MIGRATION_MARKER)
  if (existsSync(marker)) return { migrated: [], alreadyDone: true, failed: [] }
  const migrated: Array<{ agentId: string; from: string; to: string }> = []
  const failed: Array<{ agentId: string; from: string }> = []
  for (const a of agents) {
    const from = join(legacyRoot, a.id, 'box')
    if (!existsSync(from)) continue
    const to = boxDir(a.id)
    try {
      await cp(from, to, { recursive: true, force: true }) // COPIA: gli originali restano
      migrated.push({ agentId: a.id, from, to })
    } catch {
      failed.push({ agentId: a.id, from })
    }
  }
  // F9 come in docker: niente marker se una copia è fallita
  if (!failed.length) writeFileSync(marker, new Date().toISOString())
  return { migrated, alreadyDone: false, failed }
}
