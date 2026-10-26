// Sandbox di esecuzione: backend 'host' (spawn diretto, gate permessi) o
// 'docker' (container per agente con volume persistente /home/box, come il box originale).
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSetting } from '../store/db'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
  trimmed: boolean
}

const MAX_OUTPUT_LINES = 10_000 // come l'originale (cap + stdout_trimmed)

export type SandboxMode = 'host' | 'docker'

export function sandboxMode(): SandboxMode {
  return getSetting<SandboxMode>('sandbox.mode', 'host')
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

async function execHost(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ExecResult> {
  return new Promise((resolve) => {
    const sh = process.env.SHELL || '/bin/sh' // come l'originale: spawn(env.SHELL ?? /bin/sh)
    const child = spawn(sh, ['-c', command], { cwd })
    let out = ''
    let err = ''
    let trimmed = false
    const onAbort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 2_000_000) out += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 2_000_000) err += d.toString()
    })
    child.on('close', (code, sig) => {
      clearTimeout(timer)
      const o = capOutput(out)
      const e = capOutput(err)
      trimmed = o.trimmed || e.trimmed
      resolve({ stdout: o.text, stderr: e.text, exitCode: code, signal: sig, trimmed })
    })
  })
}

async function execDocker(agentId: string, command: string, timeoutMs: number, signal: AbortSignal): Promise<ExecResult> {
  const container = `sandbot-${agentId}`
  await ensureContainer(agentId)
  const full = `docker exec -w /home/box ${container} sh -c ${JSON.stringify(command)}`
  // riusa execHost con cwd neutro
  return execHost(full, join(homedir(), 'SandBot', agentId), timeoutMs, signal)
}

export async function ensureContainer(agentId: string): Promise<void> {
  const container = `sandbot-${agentId}`
  const volume = `sandbot-${agentId}-box`
  const mode = sandboxMode()
  if (mode !== 'docker') return
  const exists = await execHost(`docker ps -a --format '{{.Names}}' | grep -qx ${container}`, join(homedir()), 5000, new AbortController().signal)
  if (exists.exitCode === 0) {
    // assicurati che sia avviato
    await execHost(`docker start ${container}`, join(homedir()), 10_000, new AbortController().signal)
    return
  }
  const create = [
    'docker create',
    '--name', container,
    '-v', `${volume}:/home/box`,
    '-w', '/home/box',
    '-i',
    'ubuntu:24.04',
    'sleep infinity'
  ].join(' ')
  const r = await execHost(create, join(homedir()), 60_000, new AbortController().signal)
  if (r.exitCode !== 0) throw new Error(`docker create fallito: ${r.stderr}`)
  await execHost(`docker start ${container}`, join(homedir()), 30_000, new AbortController().signal)
}

export async function execCommand(agentId: string, command: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  const { timeoutMs = 120_000, signal = new AbortController().signal } = opts
  if (sandboxMode() === 'docker') return execDocker(agentId, command, timeoutMs, signal)
  return execHost(command, boxDir(agentId), timeoutMs, signal)
}

// ---- operazioni file (passano sempre dal backend attivo) ----
export async function readFileInBox(agentId: string, path: string): Promise<string> {
  const safe = path.replace(/'/g, "'\\''")
  const r = await execCommand(agentId, `cat ${JSON.stringify(path)}`)
  if (r.exitCode !== 0) throw new Error(r.stderr || `read fallito (${path})`)
  void safe
  return r.stdout
}

export async function writeFileInBox(agentId: string, path: string, content: string): Promise<void> {
  // qui Scrivo via heredoc per evitare problemi di quoting
  const r = await execCommand(agentId, `mkdir -p $(dirname ${JSON.stringify(path)}) && cat > ${JSON.stringify(path)} <<'SANDBOT_EOF'\n${content}\nSANDBOT_EOF`)
  if (r.exitCode !== 0) throw new Error(r.stderr || `write fallito (${path})`)
}

export async function listDirectoryInBox(agentId: string, path: string): Promise<string> {
  const r = await execCommand(agentId, `ls -la ${JSON.stringify(path)}`)
  if (r.exitCode !== 0) throw new Error(r.stderr || `ls fallito (${path})`)
  return r.stdout
}
