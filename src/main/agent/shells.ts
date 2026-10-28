// Comandi LUNGHI in background (fase 11, punto 3): run-command con
// background:true parte dallo STESSO gate permessi (il gate sta a monte, nel
// loop) e torna subito {shellId}; l'output va su un file di log nella home
// del bot (.sandbot/shells/<id>.log) e l'exit code su un file accanto. In
// ENTRAMBE le modalità il comando gira dentro un wrapper COSTANTE (argv
// puro): è lui a creare la cartella, eseguire `sh -c` in un GRUPPO di
// processi suo e scrivere pid ed exit file — la fine del comando NON dipende
// dal daemon (F3: se il daemon si riavvia, tick e await_shell leggono l'exit
// file e chiudono la riga). La riga vive nella tabella durevole shell_jobs:
// al riavvio del daemon si riconcilia (exit file → finito; processo sparito
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
import type { DatabaseSync } from 'node:sqlite'
import { db as dbFn } from '../store/db'
import { createShellJob, getShellJob, updateShellJob, runningShellJobsOf, runningShellJobsAll, SHELLS_PER_AGENT_MAX, SHELLS_PER_BOX_MAX, SHELL_MAX_DURATION_MS, type ShellJob } from '../store/shell-jobs'
import { sandboxMode, boxDir, readFileInBox, ensureBoxContainer, ensureBotHome, execCommand, capOutput } from '../sandbox'
import { dockerExecBackgroundArgv, dockerKillGroupArgv, dockerClientEnv, DOCKER_BG_WRAPPER_SH, BOX_CONTAINER, boxHomePath } from '../sandbox/docker-argv'
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

/**
 * Il pgid letto dal pid file del wrapper (G1, puro): un INTERO POSITIVO, o il
 * motivo per cui NON si uccide nulla — un pid file vuoto o non numerico non
 * diventa mai un kill (un pgid a caso prenderebbe processi innocenti del box).
 */
export function parseShellPgid(raw: string | null): { ok: true; pgid: number } | { ok: false; reason: string } {
  const t = raw?.trim() ?? ''
  if (!/^\d+$/.test(t) || Number(t) <= 0) {
    return { ok: false, reason: `pid file ${t === '' ? 'vuoto' : `non numerico ("${t.slice(0, 50)}")`}: nessun kill` }
  }
  return { ok: true, pgid: Number(t) }
}

/**
 * Esito dell'avvio di un comando in background (H2): ok col pid (host), o —
 * solo in docker — l'exit code ≠ 0 di `docker exec -d` con lo stderr: -d torna
 * subito, ma gli errori di avvio (es. il chdir di una home assente) arrivano
 * nell'exit code, e il comando NON è mai partito.
 */
export type ShellLaunch = { ok: true; pid: number | null } | { ok: false; exitCode: number | null; stderr: string }

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
  /** avvio del processo in background (default: spawn host / docker exec -d); H2: in docker l'esito porta l'exit code di exec -d */
  launch?(agentId: string, command: string, env: Record<string, string>, paths: { log: string; exit: string; pid: string }): Promise<ShellLaunch>
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

/**
 * Kill del GRUPPO di processi di un comando in host (F3): SIGTERM a tutto il
 * gruppo (shell E figli — es. npm run build → node), poi SIGKILL dopo 5 s di
 * grazia se il gruppo è ancora vivo.
 */
async function killProcessGroup(deps: ShellHostDeps, pgid: number): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch {
    return // gruppo già morto
  }
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    try {
      process.kill(-pgid, 0)
    } catch {
      return
    }
  }
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch { /* già morto */ }
}

/** docker con argv PURI: torna l'exit code del comando (null se docker non parte). */
async function dockerArgvExit(argv: string[]): Promise<number | null> {
  return (await dockerArgvRun(argv)).exitCode
}

/**
 * docker con argv PURI attendendo exit code E stderr (H2): gli errori di
 * avvio di `exec -d` — es. il chdir di una home assente — arrivano lì.
 */
async function dockerArgvRun(argv: string[], env?: Record<string, string>): Promise<{ exitCode: number | null; stderr: string }> {
  const { spawn: sp } = await import('node:child_process')
  return new Promise((resolve) => {
    const p = sp('docker', argv, { env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr?.on('data', (d: Buffer) => {
      if (err.length < 100_000) err += d.toString()
    })
    p.on('error', () => resolve({ exitCode: null, stderr: err }))
    p.on('close', (code) => resolve({ exitCode: code, stderr: err }))
  })
}

/**
 * Terminazione di default (F3 + G1): in host kill del GRUPPO letto dal pid
 * file (lo scrive il wrapper; fallback al pid del DB); in docker ARGV PURI al
 * /usr/bin/kill di procps del container (`kill -TERM -- -<pgid>`, niente `sh
 * -c`: il kill interno di dash non accetta `--`) col pgid letto dal pid file
 * e validato intero positivo — e come in host, dopo 5 s di grazia col segnale
 * 0 di esistenza, SIGKILL se il gruppo è ancora vivo.
 */
function defaultTerminate(deps: ShellHostDeps): (agentId: string, job: ShellJob) => Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  return async (agentId, job) => {
    const parsed = parseShellPgid(await deps.readBoxFile?.(agentId, backgroundShellPaths(job.id).pid) ?? null)
    if (job.mode === 'docker') {
      if (!parsed.ok) {
        // nessun kill con un pgid a caso: il motivo resta nel log del daemon
        console.warn(`[shells] ${job.id}: ${parsed.reason}`)
        return
      }
      await dockerArgvExit(dockerKillGroupArgv(BOX_CONTAINER, parsed.pgid, 'TERM'))
      for (let i = 0; i < 10; i++) {
        await sleep(500)
        // segnale 0 = sola esistenza del gruppo (rc != 0, docker incluso, = morto)
        if (await dockerArgvExit(dockerKillGroupArgv(BOX_CONTAINER, parsed.pgid, '0')) !== 0) return
      }
      await dockerArgvExit(dockerKillGroupArgv(BOX_CONTAINER, parsed.pgid, 'KILL'))
      return
    }
    const pgid = parsed.ok ? parsed.pgid : job.pid
    if (pgid) await killProcessGroup(deps, pgid)
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
  const launch = deps.launch ?? defaultShellLaunch(mode)
  const started = await launch(agentId, rawCommand, env, paths)
  if (!started.ok) {
    // H2: il comando NON è mai partito → NESSUNA riga shell_jobs (niente da
    // attendere, riconciliare o notificare) e un result chiaro al bot
    return { ok: false, error: await launchErrorText(deps, secretNames, started) }
  }
  createShellJob(database, {
    id, agent_id: agentId, command: rawCommand, secret_names: secretNames,
    mode, pid: started.pid, log_path: paths.log, started_at: deps.now()
  })
  return { ok: true, shellId: id }
}

/**
 * L'avvio di default di un comando nel wrapper COSTANTE (host e docker), usato
 * sia dal background sia dal foreground con auto-promozione (0a): host è un
 * figlio detached con /bin/sh, docker è `exec -d` di cui si attende l'exit
 * code (H2: gli errori di avvio, es. il chdir di una home assente, arrivano lì).
 */
function defaultShellLaunch(mode: 'host' | 'docker'): NonNullable<ShellHostDeps['launch']> {
  return async (agentId, command, env, p): Promise<ShellLaunch> => {
    if (mode === 'docker') {
      await ensureBoxContainer()
      try {
        await ensureBotHome(agentId) // H2: -w punta alla home del bot
      } catch (e) {
        return { ok: false, exitCode: null, stderr: e instanceof Error ? e.message : String(e) }
      }
      const home = boxHomePath(agentId)
      const env2 = { HOME: home, ...env }
      // H2: -d torna subito, ma l'exit code dice se il comando è PARTITO: si
      // attende — un errore di avvio non lascia più la riga "running" per 6
      // ore su un comando mai partito. Il wrapper costante scrive
      // pid/log/exit nel box. F2: nel client docker sull'HOST restano il
      // daemon + i SOLI segreti; HOME del bot viaggia col valore nell'argv
      // (-e HOME=/box/home/<id>)
      const r = await dockerArgvRun(dockerExecBackgroundArgv(BOX_CONTAINER, command, { workdir: home, env: env2 }, p), dockerClientEnv(env2))
      if (r.exitCode !== 0) return { ok: false, exitCode: r.exitCode, stderr: r.stderr }
      return { ok: true, pid: null }
    }
    // F3: lo STESSO wrapper costante del docker, eseguito con /bin/sh: è lui
    // a scrivere pid ed exit file, quindi la chiusura non dipende dal daemon
    // (un riavvio non lascia la riga appesa). detached: il wrapper è un
    // gruppo di processi SUO → il kill del gruppo prende anche i figli.
    const child = spawn('/bin/sh', ['-c', DOCKER_BG_WRAPPER_SH, 'sh', command, p.log, p.exit, p.pid], {
      cwd: boxDir(agentId),
      env: { ...process.env, ...env },
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return { ok: true, pid: child.pid ?? null }
  }
}

// ---- fase 11b (0a): auto-background del foreground, deciso dal CODICE ----

/** Dopo quanti secondi un run-command in foreground viene promosso in background (default 60 s). */
export const PROMOTE_AFTER_SEC = 60

/** La soglia effettiva in secondi: iniettabile nei test (SANDBOT_TEST_PROMOTE_AFTER_SEC). */
export function promoteAfterSec(): number {
  const v = Number(process.env.SANDBOT_TEST_PROMOTE_AFTER_SEC)
  return Number.isFinite(v) && v > 0 ? v : PROMOTE_AFTER_SEC
}

export interface ForegroundFacts {
  /** i tetti delle shell (4 per bot, 8 per box) sono pieni */
  capsFull: boolean
  /** l'exit file del wrapper è comparso entro la soglia */
  exited: boolean
}

export type ForegroundPlan =
  | { kind: 'fallback'; why: string } // come prima: foreground col timeout = kill
  | { kind: 'done' }                  // finito in tempo: result come oggi
  | { kind: 'promote' }               // ancora in corsa: RESTA in background (SHELL_DONE)

/**
 * 0a (PURO): che ne è di un run-command in foreground. Tetti pieni → il
 * comportamento di prima (timeout = kill), col motivo nel result. Finisce
 * entro la soglia → result come oggi. Non finisce → promozione in background:
 * da lì vale tutto il percorso SHELL_DONE già esistente.
 */
export function foregroundOutcome(facts: ForegroundFacts): ForegroundPlan {
  if (facts.capsFull) {
    return {
      kind: 'fallback',
      why: `i comandi in background simultanei sono al massimo (${SHELLS_PER_AGENT_MAX} per bot, ${SHELLS_PER_BOX_MAX} per box): questo è girato in foreground col timeout, oltre il quale viene terminato`
    }
  }
  return facts.exited ? { kind: 'done' } : { kind: 'promote' }
}

/**
 * Il backoff della lettura dell'exit file (0a, PURO): 250 ms → 500 → 1 s → 1 s…
 * In docker ogni lettura è un `docker exec`: un exec ogni 250 ms per minuti
 * non ce lo possiamo permettere.
 */
export function exitPollDelayMs(reads: number): number {
  return Math.min(250 * 2 ** Math.max(0, reads - 1), 1_000)
}

export interface ForegroundResult {
  output: string
  meta: Record<string, unknown>
}

/**
 * 0a: un run-command SENZA background:true parte col lo STESSO wrapper
 * costante del background (riga shell_jobs compresa) e il daemon attende al
 * più `promoteAfterSec` (o il timeout chiesto dal modello, se minore).
 * Finisce in tempo → result come oggi (exit code e output redatto e limitato
 * come capOutput; unica differenza: stdout e stderr arrivano insieme, nell'ordine)
 * e la riga si chiude GIÀ letta (nessun SHELL_DONE). Non finisce → il comando
 * RESTA in esecuzione e il result annuncia la promozione (shellId): da lì
 * valgono await_shell e la notifica di fine. Tetti pieni → foreground di una
 * volta (timeout = kill) col motivo nel result. Il gate permessi sta a monte,
 * nel loop, PRIMA della partenza: qui non si decide nulla di chi può partire.
 */
export async function runForegroundShell(
  agentId: string,
  rawCommand: string,
  env: Record<string, string>,
  secretNames: string[],
  opts: { timeoutMs?: number } = {},
  depsIn: Partial<ShellHostDeps> = {}
): Promise<ForegroundResult> {
  const deps = { ...defaultDeps(), ...depsIn }
  const database = deps.db()
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const timeoutMs = opts.timeoutMs ?? 120_000
  const capsFull =
    runningShellJobsOf(database, agentId).length >= SHELLS_PER_AGENT_MAX ||
    runningShellJobsAll(database).length >= SHELLS_PER_BOX_MAX
  const capsPlan = foregroundOutcome({ capsFull, exited: false })
  if (capsPlan.kind === 'fallback') {
    // com'era: exec diretto col timeout = kill, con la nota del perché
    const r = await execCommand(agentId, rawCommand, { timeoutMs, env })
    const redact = async (t: string): Promise<string> => {
      if (!secretNames.length) return t
      try {
        const used = await Promise.all(secretNames.map(async (name) => ({ name, envName: `SANDBOT_SECRET_${name}`, value: await deps.reveal!(name) })))
        return redactSecrets(t, used)
      } catch {
        return '(output omesso: impossibile redarre i segreti del comando)'
      }
    }
    const parts: string[] = []
    if (r.stdout) parts.push(await redact(r.stdout))
    if (r.stderr) parts.push('[stderr]\n' + (await redact(r.stderr)))
    parts.push(`[exit ${r.exitCode ?? 'killed'}${r.trimmed ? ' — output trimmed' : ''}]`)
    parts.push(`[nota: ${capsPlan.why}]`)
    return { output: parts.join('\n'), meta: { exitCode: r.exitCode, trimmed: r.trimmed, capsFull: true } }
  }
  const id = `sh-${randomUUID().slice(0, 12)}`
  const paths = backgroundShellPaths(id)
  const mode = sandboxMode() === 'docker' ? 'docker' : 'host'
  const launch = deps.launch ?? defaultShellLaunch(mode)
  const started = await launch(agentId, rawCommand, env, paths)
  if (!started.ok) {
    // H2 come il background: il comando non è mai partito
    return { output: await launchErrorText(deps, secretNames, started), meta: { launchFailed: true } }
  }
  createShellJob(database, {
    id, agent_id: agentId, command: rawCommand, secret_names: secretNames,
    mode, pid: started.pid, log_path: paths.log, started_at: deps.now()
  })
  // la soglia di promozione: promoteAfterSec, MAI oltre il timeout chiesto
  const promoteAfterMs = Math.min(promoteAfterSec() * 1000, timeoutMs)
  const deadline = deps.now() + promoteAfterMs
  let exitRaw: string | null = null
  for (let reads = 1; deps.now() < deadline; reads++) {
    await sleep(exitPollDelayMs(reads))
    const raw = await deps.readBoxFile?.(agentId, paths.exit) ?? null
    if (raw !== null && raw.trim() !== '') {
      exitRaw = raw
      break
    }
  }
  const plan = foregroundOutcome({ capsFull, exited: exitRaw !== null && exitRaw.trim() !== '' })
  if (plan.kind === 'promote') {
    return {
      output: `Il comando è ancora in corso dopo ${Math.round(promoteAfterMs / 1000)} s: l'ho passato in background (shellId ${id}). Ti arriva l'esito alla fine (messaggio di sistema con le ultime righe), oppure leggilo subito con await_shell({shellId: "${id}"}). Log: ${paths.log}. Tetto: 6 ore.`,
      meta: { shellId: id, background: true, promoted: true }
    }
  }
  // finito in tempo: result come oggi, riga chiusa e marcata LETTA (nessuna
  // notifica SHELL_DONE per un comando che il bot ha già davanti)
  const exitCode = exitRaw !== null && Number.isFinite(Number(exitRaw.trim())) ? Number(exitRaw.trim()) : null
  const rawLog = await deps.readBoxFile?.(agentId, paths.log) ?? ''
  const redactedLog = await (async () => {
    if (!secretNames.length) return rawLog
    try {
      const used = await Promise.all(secretNames.map(async (name) => ({ name, envName: `SANDBOT_SECRET_${name}`, value: await deps.reveal!(name) })))
      return redactSecrets(rawLog, used)
    } catch {
      return '(output omesso: impossibile redarre i segreti del comando)'
    }
  })()
  const capped = capOutput(redactedLog)
  updateShellJob(database, id, { status: 'done', exit_code: exitCode, finished_at: deps.now(), awaited: true, notified: true })
  return {
    output: `${capped.text}\n[exit ${exitCode ?? '?'}${capped.trimmed ? ' — output trimmed' : ''}]`,
    meta: { exitCode, trimmed: capped.trimmed }
  }
}

/**
 * H2: il messaggio dell'avvio fallito, con lo stderr REDATTO coi segreti del
 * comando (come l'output di oggi). Se la redazione non è possibile, l'esito
 * non si mostra. Usato dal background e dal foreground col wrapper (0a).
 */
async function launchErrorText(
  deps: ShellHostDeps,
  secretNames: string[],
  failed: { exitCode: number | null; stderr: string }
): Promise<string> {
  const why = failed.stderr.trim().slice(0, 2_000)
  const head = `Il comando non è mai partito (exit ${failed.exitCode ?? 'docker assente'}).`
  if (!secretNames.length) return why ? `${head} ${why}` : head
  try {
    const used = await Promise.all(secretNames.map(async (name) => ({ name, envName: `SANDBOT_SECRET_${name}`, value: await deps.reveal!(name) })))
    const redacted = redactSecrets(why, used)
    return redacted ? `${head} ${redacted}` : head
  } catch {
    return `${head} Esito non mostrato: impossibile redarre i segreti del comando.`
  }
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
    const terminate = deps.terminate ?? defaultTerminate(deps)
    await terminate(agentId, job)
    updateShellJob(database, shellId, { status: 'killed', finished_at: deps.now() })
  }
  const deadline = deps.now() + Math.min(60, Math.max(1, Math.floor(opts.timeoutSec ?? 60))) * 1000
  while (job && job.status === 'running' && deps.now() < deadline) {
    await sleep(250)
    // la fine la rileva l'EXIT FILE (lo scrive il wrapper, non il daemon):
    // così await_shell chiude la riga anche subito dopo un riavvio
    const raw = await deps.readBoxFile?.(agentId, backgroundShellPaths(shellId).exit) ?? null
    if (raw !== null && raw.trim() !== '') await finalizeFromExitFile(deps, agentId, shellId, null)
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
 * il cui exit file è comparso (lo scrive il WRAPPER, in entrambe le modalità),
 * UCCIDE davvero quelli oltre le 6 ore (kill del gruppo, poi notifica) e, in
 * riconciliazione, segna LOST i processi spariti senza exit code.
 * Torna quante righe ha toccato.
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
      // durata massima 6 ore: il comando va UCCISO davvero (host e docker),
      // poi la riga si chiude con la notifica
      const terminate = deps.terminate ?? defaultTerminate(deps)
      await terminate(job.agent_id, job)
      await finishShell(deps, job, 'expired', null)
      touched++
      continue
    }
    if (opts.reconcile && job.mode === 'host') {
      // riavvio del daemon: processo sparito senza exit code → lost. Il pid
      // del DB è il pgid del gruppo del wrapper → il segnale 0 al gruppo
      // negativo dice se è vivo. Limite noto (F3): un pid RIUSATO da un
      // processo avviato DOPO started_at non si distingue col solo segnale 0
      // (servirebbe l'orario di avvio del pid via ps: non portabile nei test).
      const alive = deps.signalRunning
        ? deps.signalRunning(job.agent_id, job.pid)
        : job.pid !== null && (() => { try { process.kill(-job.pid, 0); return true } catch { return false } })()
      if (!alive) {
        await finishShell(deps, job, 'lost', null)
        touched++
      }
    }
  }
  return touched
}
