// Comandi LUNGHI in background (fase 11, punto 3): run-command con
// background:true parte dallo STESSO gate permessi (il gate sta a monte, nel
// loop) e torna subito {shellId}; l'output va su un file di log nella home
// del bot (.sandbot/shells/<id>.log) e l'exit code su un file accanto — in
// host con un processo figlio, in docker con `docker exec -d` e un wrapper
// COSTANTE (argv puro). La riga vive nella tabella durevole shell_jobs: al
// riavvio del daemon si riconcilia (exit file → finito; processo sparito
// senza exit → lost). Quando il comando finisce il daemon accoda un job
// SHELL_DONE per il bot (evento esterno, turno untrusted) col blocco evidenza
// <comando_finito id exit> e le ultime 50 righe redatte — salvo che il bot
// abbia già letto l'esito con await_shell.
//
// Dipendenze iniettabili (spawn, filesystem del box, orologio, enqueue): i
// test non dipendono da Docker; i processi figlio in host sono veri ma
// innocui (echo/sleep su directory temporanea).
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { openSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { db as dbFn } from '../store/db'
import { createShellJob, getShellJob, updateShellJob, runningShellJobsOf, runningShellJobsAll, SHELLS_PER_AGENT_MAX, SHELLS_PER_BOX_MAX, SHELL_MAX_DURATION_MS, type ShellJob } from '../store/shell-jobs'
import { sandboxMode, boxDir, readFileInBox, ensureBoxContainer } from '../sandbox'
import { dockerExecBackgroundArgv, dockerKillArgv, BOX_CONTAINER, boxHomePath } from '../sandbox/docker-argv'
import { formatShellDone } from '../../shared/agent-message'
import { redactSecrets } from './secrets'

/** I path (relativi alla home del bot) di log, exit code e pid di una shell. */
export function backgroundShellPaths(id: string): { log: string; exit: string; pid: string } {
  return {
    log: `.sandbot/shells/${id}.log`,
    exit: `.sandbot/shells/${id}.exit`,
    pid: `.sandbot/shells/${id}.pid`
  }
}

/** Le ultime N righe di un testo (puro). */
export function lastLines(text: string, n: number): string {
  const lines = text.split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

export interface ShellHostDeps {
  db(): DatabaseSync
  now(): number
  /** legge un file del box (null se assente); default readFileInBox con null su errore */
  readBoxFile?(agentId: string, path: string): Promise<string | null>
  /** rivela un segreto del vault per redarre l'output (default: vault reale) */
  reveal?(name: string): Promise<string>
  /** accoda il job user-message SHELL_DONE (default: enqueueJob della coda) */
  enqueue?(agentId: string, text: string, extraMeta: Record<string, unknown>): void
  sleep?(ms: number): Promise<void>
  /** avvio del processo in background (default: spawn host / docker exec -d) */
  launch?(agentId: string, command: string, env: Record<string, string>, paths: { log: string; exit: string; pid: string }): Promise<number | null>
  /** termina il comando (default: kill del pid host / docker exec kill) */
  terminate?(agentId: string, job: ShellJob): Promise<void>
  signalRunning?(agentId: string, pid: number | null): boolean
}

const defaultDeps = (): ShellHostDeps => ({
  db: dbFn,
  now: () => Date.now(),
  readBoxFile: async (agentId, path) => {
    try {
      return await readFileInBox(agentId, path)
    } catch {
      return null
    }
  },
  reveal: async (name) => {
    const { revealSecret } = await import('../vault')
    return revealSecret(name)
  },
  enqueue: (agentId, text, extraMeta) => {
    void import('../store/jobs').then(({ enqueueJob }) => {
      const now = Date.now()
      enqueueJob(dbFn(), {
        agentId,
        kind: 'user-message',
        payload: { text, initiator: 'SHELL_DONE', untrusted: true, extraMeta },
        runAt: now,
        now
      })
    }).catch(() => undefined)
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms))
})

/** L'output del log redatto coi segreti usati dal comando (come l'output di oggi). */
async function redactedTail(deps: ShellHostDeps, agentId: string, logPath: string, lines: number, secretNames: string[]): Promise<string> {
  const raw = await deps.readBoxFile?.(agentId, logPath) ?? null
  if (raw === null) return '(log non ancora scritto)'
  const tail = lastLines(raw, lines)
  if (!secretNames.length) return tail
  try {
    const used = await Promise.all(secretNames.map(async (name) => ({ name, envName: `SANDBOT_SECRET_${name}`, value: await deps.reveal!(name) })))
    return redactSecrets(tail, used)
  } catch {
    // impossibile verificare la redazione: l'output NON entra nel contesto
    return '(output omesso: impossibile redarre i segreti del comando)'
  }
}

/** Avvia un comando in background (dopo il gate) e registra la riga durevole. */
export async function startBackgroundShell(
  agentId: string,
  rawCommand: string,
  env: Record<string, string>,
  secretNames: string[],
  depsIn: Partial<ShellHostDeps> = {}
): Promise<{ ok: true; shellId: string } | { ok: false; error: string }> {
  const deps = { ...defaultDeps(), ...depsIn }
  const database = deps.db()
  // tetti: 4 per bot, 8 per box (oltre → result esplicito, nessuna partenza)
  const perAgent = runningShellJobsOf(database, agentId).length
  if (perAgent >= SHELLS_PER_AGENT_MAX) {
    return { ok: false, error: `Limite raggiunto: al massimo ${SHELLS_PER_AGENT_MAX} comandi in background per bot (ne hai ${perAgent}). Leggi un esito con await_shell o termina un comando con kill.` }
  }
  const perBox = runningShellJobsAll(database).length
  if (perBox >= SHELLS_PER_BOX_MAX) {
    return { ok: false, error: `Limite raggiunto: al massimo ${SHELLS_PER_BOX_MAX} comandi in background per box (ne girano ${perBox}). Attendi o termina qualcosa.` }
  }
  const id = `sh-${randomUUID().slice(0, 12)}`
  const paths = backgroundShellPaths(id)
  const mode = sandboxMode() === 'docker' ? 'docker' : 'host'
  const launch = deps.launch ?? (async (agentId2, command, env2, p): Promise<number | null> => {
    if (mode === 'docker') {
      await ensureBoxContainer()
      const home = boxHomePath(agentId2)
      // -d: torna subito; il wrapper costante scrive pid/log/exit nel box
      const { spawn: sp } = await import('node:child_process')
      sp('docker', dockerExecBackgroundArgv(BOX_CONTAINER, command, { workdir: home, env: { HOME: home, ...env2 } }, p), {
        env: { ...process.env, HOME: home, ...env2 },
        stdio: 'ignore'
      })
      return null
    }
    const logAbs = join(boxDir(agentId2), p.log)
    mkdirSync(dirname(logAbs), { recursive: true })
    const fd = openSync(logAbs, 'a')
    const sh = process.env.SHELL || '/bin/sh'
    const child = spawn(sh, ['-c', command], {
      cwd: boxDir(agentId2),
      env: { ...process.env, ...env2 },
      stdio: ['ignore', fd, fd]
    })
    child.on('close', (code) => {
      // exit code su file accanto al log (come in docker): è ciò che la
      // riconciliazione e il tick leggono; poi la riga si chiude e la
      // notifica SHELL_DONE parte (se il bot non ha già letto con await_shell)
      try {
        writeFileSync(join(boxDir(agentId2), p.exit), String(code ?? 'unknown'))
      } catch { /* il tick proverà col file */ }
      void finalizeFromExitFile(deps, agentId2, id, code)
    })
    return child.pid ?? null
  })
  const pid = await launch(agentId, rawCommand, env, paths)
  createShellJob(database, {
    id, agent_id: agentId, command: rawCommand, secret_names: secretNames,
    mode, pid, log_path: paths.log, started_at: deps.now()
  })
  return { ok: true, shellId: id }
}

/** Chiude la riga e (se il bot non ha già letto) accoda la notifica SHELL_DONE. */
async function finishShell(deps: ShellHostDeps, job: ShellJob, status: 'done' | 'killed' | 'lost' | 'expired', exitCode: number | null): Promise<void> {
  const already = getShellJob(deps.db(), job.id)
  if (!already || already.status !== 'running') return
  updateShellJob(deps.db(), job.id, { status, exit_code: exitCode, finished_at: deps.now() })
  if (already.awaited) return // il bot ha già letto l'esito con await_shell
  const tail = await redactedTail(deps, job.agent_id, job.log_path, 50, job.secret_names)
  deps.enqueue?.(job.agent_id, [
    formatShellDone(job.command, job.id, exitCode, tail, status),
    "Il comando in background è finito: decidi se proseguire il lavoro, avvisare l'utente con send_to_user o tacere."
  ].join('\n'), { shellId: job.id, shellStatus: status })
  updateShellJob(deps.db(), job.id, { notified: true })
}

/** L'exit file è comparso (host: chiusura del figlio; docker/poll: lettura). */
async function finalizeFromExitFile(deps: ShellHostDeps, agentId: string, id: string, code: number | null): Promise<void> {
  const job = getShellJob(deps.db(), id)
  if (!job || job.status !== 'running') return
  if (code === null) {
    // in docker l'exit code si legge dal file nel box
    const raw = await deps.readBoxFile?.(agentId, backgroundShellPaths(id).exit) ?? null
    code = raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw.trim())) ? Number(raw.trim()) : null
  }
  await finishShell(deps, job, 'done', code)
}

/**
 * await_shell({shellId, timeout_sec?, kill?}): attende fino a 60 s, poi
 * restituisce stato, exit code e le ultime 200 righe (redatte come l'output
 * di oggi). Con kill: true termina il comando. Segna la riga come letta:
 * niente notifica SHELL_DONE dopo una lettura.
 */
export async function awaitShell(
  agentId: string,
  shellId: string,
  opts: { timeoutSec?: number; kill?: boolean } = {},
  depsIn: Partial<ShellHostDeps> = {}
): Promise<string> {
  const deps = { ...defaultDeps(), ...depsIn }
  const database = deps.db()
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let job = getShellJob(database, shellId)
  if (!job) return `Nessun comando in background con shellId "${shellId}": gli id validi arrivano da run-command con background:true.`
  if (job.agent_id !== agentId) return `Il comando ${shellId} non è tuo (è di un altro bot): non puoi attenderlo.`
  if (opts.kill) {
    const terminate = deps.terminate ?? (async (agentId2, j) => {
      if (j.mode === 'docker') {
        const pidFile = backgroundShellPaths(j.id).pid
        const pidRaw = await deps.readBoxFile?.(agentId2, pidFile)
        if (pidRaw && pidRaw.trim() && Number.isFinite(Number(pidRaw.trim()))) {
          const { spawn: sp } = await import('node:child_process')
          sp('docker', dockerKillArgv(BOX_CONTAINER, backgroundShellPaths(j.id).pid), { stdio: 'ignore' })
        }
        return
      }
      if (j.pid) {
        try { process.kill(j.pid, 'SIGTERM') } catch { /* già morto */ }
      }
    })
    await terminate(agentId, job)
    updateShellJob(database, shellId, { status: 'killed', finished_at: deps.now() })
  }
  const deadline = deps.now() + Math.min(60, Math.max(1, Math.floor(opts.timeoutSec ?? 60))) * 1000
  while (job && job.status === 'running' && deps.now() < deadline) {
    await sleep(250)
    job = getShellJob(database, shellId)
  }
  if (!job) return `Comando ${shellId} scomparso.`
  // il bot ha letto l'esito: la notifica di fine non serve
  updateShellJob(database, shellId, { awaited: true })
  const tail = await redactedTail(deps, agentId, job.log_path, 200, job.secret_names)
  const stato = job.status === 'running'
    ? 'ancora IN CORSO (timeout di attesa scaduto)'
    : job.status === 'done'
      ? `finito, exit ${job.exit_code ?? '?'}`
      : job.status
  return `Comando ${shellId} \`$ ${job.command}\`: ${stato}.\nUltime righe del log:\n${tail}`
}

/**
 * Il tick del daemon (e la riconciliazione al riavvio): finalizza i comandi
 * il cui exit file è comparso (docker), uccide quelli oltre le 6 ore (kill
 * con notifica) e, in riconciliazione, segna LOST i processi spariti senza
 * exit code. Torna quante righe ha toccato.
 */
export async function tickShellJobs(depsIn: Partial<ShellHostDeps> = {}, opts: { reconcile?: boolean } = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...depsIn }
  const database = deps.db()
  let touched = 0
  for (const job of runningShellJobsAll(database)) {
    const exitRaw = await deps.readBoxFile?.(job.agent_id, backgroundShellPaths(job.id).exit) ?? null
    if (exitRaw !== null && exitRaw.trim() !== '') {
      await finalizeFromExitFile(deps, job.agent_id, job.id, null)
      touched++
      continue
    }
    if (deps.now() - job.started_at > SHELL_MAX_DURATION_MS) {
      // durata massima 6 ore: kill con notifica
      await finishShell(deps, job, 'expired', null)
      touched++
      continue
    }
    if (opts.reconcile && job.mode === 'host') {
      // riavvio del daemon: processo sparito senza exit code → lost
      const alive = deps.signalRunning
        ? deps.signalRunning(job.agent_id, job.pid)
        : job.pid !== null && (() => { try { process.kill(job.pid, 0); return true } catch { return false } })()
      if (!alive) {
        await finishShell(deps, job, 'lost', null)
        touched++
      }
    }
  }
  return touched
}
