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
import { mkdirSync, existsSync, writeFileSync, realpathSync as realpathSyncHost } from 'node:fs'
import { readFile, writeFile, readdir, mkdir, rename, cp, copyFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { getSetting, dataDir } from '../store/db'
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
  dockerVolumeLsArgv,
  dockerClientEnv,
  BOX_CONTAINER,
  BOX_VOLUME,
  BOX_MOUNT,
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

/** Limiti condivisi del box, configurabili (punto 1: memoria 4g, cpu 2, pids 1024). */
export function boxLimits(): BoxLimits {
  return {
    memory: String(getSetting<string>('sandbox.boxMemory', DEFAULT_BOX_LIMITS.memory)),
    cpus: Number(getSetting<number>('sandbox.boxCpus', DEFAULT_BOX_LIMITS.cpus)),
    pids: Number(getSetting<number>('sandbox.boxPids', DEFAULT_BOX_LIMITS.pids))
  }
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

/** La home del bot dentro il box condiviso (cwd predefinita dei suoi comandi). */
export function boxDir(agentId: string): string {
  const dir = join(boxRoot(), 'home', agentId)
  mkdirSync(dir, { recursive: true })
  return dir
}

function capOutput(text: string): { text: string; trimmed: boolean } {
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
  return runProcess('docker', argv, opts)
}

/** Esecuzione nel container condiviso: argv, senza shell dell'host; ogni exec gira nella home del bot con la sua HOME. */
async function execDocker(agentId: string, command: string, opts: ExecOptions): Promise<ExecResult> {
  const home = boxHomePath(agentId)
  const env = { HOME: home, ...(opts.env ?? {}) }
  const r = await docker(dockerExecArgv(BOX_CONTAINER, command, { workdir: home, env }), {
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
 * Il container UNICO del box condiviso (punto 1): come il vecchio
 * ensureContainer per agente, ma con volume `sandbot-box` montato su /box e
 * limiti condivisi configurabili.
 */
export async function ensureBoxContainer(): Promise<void> {
  if (sandboxMode() !== 'docker') return
  const ps = await runProcess('docker', dockerPsArgv(BOX_CONTAINER), { timeoutMs: 15_000 })
  const exists = ps.exitCode === 0 && ps.stdout.trim().split('\n').includes(BOX_CONTAINER)
  if (exists) {
    const start = await runProcess('docker', dockerStartArgv(BOX_CONTAINER), { timeoutMs: 30_000 })
    if (start.exitCode !== 0) throw new Error(`docker start fallito: ${start.stderr}`)
    return
  }
  // prima creazione: il volume è di root, il container gira non-root senza caps
  const chown = await runProcess('docker', dockerBoxChownArgv(BOX_VOLUME), { timeoutMs: 60_000 })
  if (chown.exitCode !== 0) throw new Error(`init volume fallito: ${chown.stderr}`)
  const create = await runProcess('docker', dockerBoxCreateArgv(BOX_CONTAINER, BOX_VOLUME, sandboxNetwork(), boxLimits()), { timeoutMs: 60_000 })
  if (create.exitCode !== 0) throw new Error(`docker create fallito: ${create.stderr}`)
  const start = await runProcess('docker', dockerStartArgv(BOX_CONTAINER), { timeoutMs: 30_000 })
  if (start.exitCode !== 0) throw new Error(`docker start fallito: ${start.stderr}`)
}

export async function execCommand(agentId: string, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  if (sandboxMode() === 'docker') return execDocker(agentId, command, opts)
  return execHost(command, boxDir(agentId), opts)
}

// ---- operazioni file (passano sempre dal backend attivo e dai confini del box) ----

/** Il path di un tool risolto e validato per la modalità attiva (host: fs reale; docker: forma). */
function checkedBoxPath(agentId: string, path: string): string {
  if (sandboxMode() === 'docker') {
    // in docker il filesystem sta nel container: solo controllo di FORMA
    // (realpath non è disponibile senza un exec in più per operazione)
    const r = resolveBoxPath(path, BOX_MOUNT, boxHomePath(agentId), (p) => p)
    if (!r.ok) throw new Error(r.reason)
    return r.abs!
  }
  const r = resolveBoxPath(path, boxRoot(), boxDir(agentId), realpathSyncHost)
  if (!r.ok) throw new Error(r.reason)
  return r.abs!
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
    const check = await run(dockerBoxMarkerCheckArgv())
    if (check.exitCode === 0) return { migrated: [], alreadyDone: true, failed: [] }
    const migrated: Array<{ agentId: string; from: string; to: string }> = []
    const failed: Array<{ agentId: string; from: string }> = []
    for (const a of agents) {
      const oldVolume = `sandbot-${a.id}-box`
      const ls = await run(dockerVolumeLsArgv(oldVolume))
      if (ls.exitCode === 0 && ls.stdout.trim().split('\n').includes(oldVolume)) {
        const copy = await run(dockerBoxMigrateArgv(oldVolume, a.id))
        if (copy.exitCode === 0) migrated.push({ agentId: a.id, from: `volume docker ${oldVolume}`, to: `/box/home/${a.id}` })
        else failed.push({ agentId: a.id, from: `volume docker ${oldVolume}` })
      }
    }
    // F9: il marker SOLO se tutto è andato bene — con copie fallite la
    // migrazione di quel bot va ritentata al prossimo avvio
    if (!failed.length) await run(dockerBoxMarkerWriteArgv())
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
