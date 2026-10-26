// Sandbox di esecuzione: backend 'host' (spawn diretto, gate permessi) o
// 'docker' (container per agente con volume persistente /home/box, come il box originale).
//
// §5.2: TUTTE le chiamate docker avvengono con spawn('docker', argv) — mai
// stringhe assemblate passate a una shell dell'host. Le operazioni file in
// modalità docker passano path come argv e contenuti via stdin; in modalità
// host usano fs/promises, non cat/heredoc.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { getSetting } from '../store/db'
import {
  dockerExecArgv,
  dockerReadFileArgv,
  dockerWriteFileArgv,
  dockerListDirArgv,
  dockerPsArgv,
  dockerStartArgv,
  dockerCreateArgv,
  dockerVolumeChownArgv
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

export function boxDir(agentId: string): string {
  const dir = join(homedir(), 'SandBot', agentId, 'box')
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

/** Esecuzione in modalità host: shell dell'utente dentro la box dell'agente (gate permessi a monte). */
async function execHost(command: string, cwd: string, opts: ExecOptions): Promise<ExecResult> {
  const sh = process.env.SHELL || '/bin/sh' // come l'originale: spawn(env.SHELL ?? /bin/sh)
  const r = await runProcess(sh, ['-c', command], { ...opts, cwd })
  const o = capOutput(r.stdout)
  const e = capOutput(r.stderr)
  return { stdout: o.text, stderr: e.text, exitCode: r.exitCode, signal: r.signal, trimmed: o.trimmed || e.trimmed }
}

function containerName(agentId: string): string {
  return `sandbot-${agentId}`
}

async function docker(agentId: string, argv: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  await ensureContainer(agentId)
  return runProcess('docker', argv, opts)
}

/** Esecuzione nel container: argv, senza shell dell'host. */
async function execDocker(agentId: string, command: string, opts: ExecOptions): Promise<ExecResult> {
  const r = await docker(agentId, dockerExecArgv(containerName(agentId), command, { env: opts.env }), {
    ...opts,
    // i valori delle env viaggiano nell'ambiente del processo docker (non in argv)
    env: opts.env
  })
  const o = capOutput(r.stdout)
  const e = capOutput(r.stderr)
  return { stdout: o.text, stderr: e.text, exitCode: r.exitCode, signal: r.signal, trimmed: o.trimmed || e.trimmed }
}

export async function ensureContainer(agentId: string): Promise<void> {
  if (sandboxMode() !== 'docker') return
  const container = containerName(agentId)
  const volume = `${container}-box`
  const ps = await runProcess('docker', dockerPsArgv(container), { timeoutMs: 15_000 })
  const exists = ps.exitCode === 0 && ps.stdout.trim().split('\n').includes(container)
  if (exists) {
    const start = await runProcess('docker', dockerStartArgv(container), { timeoutMs: 30_000 })
    if (start.exitCode !== 0) throw new Error(`docker start fallito: ${start.stderr}`)
    return
  }
  // prima creazione: il volume è di root, il container gira non-root senza caps
  const chown = await runProcess('docker', dockerVolumeChownArgv(volume), { timeoutMs: 60_000 })
  if (chown.exitCode !== 0) throw new Error(`init volume fallito: ${chown.stderr}`)
  const create = await runProcess('docker', dockerCreateArgv(container, volume, sandboxNetwork()), { timeoutMs: 60_000 })
  if (create.exitCode !== 0) throw new Error(`docker create fallito: ${create.stderr}`)
  const start = await runProcess('docker', dockerStartArgv(container), { timeoutMs: 30_000 })
  if (start.exitCode !== 0) throw new Error(`docker start fallito: ${start.stderr}`)
}

export async function execCommand(agentId: string, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  if (sandboxMode() === 'docker') return execDocker(agentId, command, opts)
  return execHost(command, boxDir(agentId), opts)
}

// ---- operazioni file (passano sempre dal backend attivo) ----

/** Resolve un path del box in modalità host (path relativi → home del box). */
function hostBoxPath(agentId: string, path: string): string {
  return resolve(boxDir(agentId), path)
}

export async function readFileInBox(agentId: string, path: string): Promise<string> {
  if (sandboxMode() === 'docker') {
    const r = await docker(agentId, dockerReadFileArgv(containerName(agentId), path), { timeoutMs: 30_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr || `read fallito (${path})`)
    return r.stdout
  }
  return readFile(hostBoxPath(agentId, path), 'utf8')
}

export async function writeFileInBox(agentId: string, path: string, content: string): Promise<void> {
  if (sandboxMode() === 'docker') {
    // path come argomento posizionale, contenuto via stdin: byte per byte identico
    const r = await docker(agentId, dockerWriteFileArgv(containerName(agentId), path), { timeoutMs: 30_000, input: content })
    if (r.exitCode !== 0) throw new Error(r.stderr || `write fallito (${path})`)
    return
  }
  const abs = hostBoxPath(agentId, path)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
}

export async function listDirectoryInBox(agentId: string, path: string): Promise<string> {
  if (sandboxMode() === 'docker') {
    const r = await docker(agentId, dockerListDirArgv(containerName(agentId), path), { timeoutMs: 30_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr || `ls fallito (${path})`)
    return r.stdout
  }
  const entries = await readdir(hostBoxPath(agentId, path), { withFileTypes: true })
  return entries.map((e) => `${e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : '-'} ${e.name}`).join('\n')
}
