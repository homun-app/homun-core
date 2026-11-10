// Fase locale (L2): il processo `llama-server` AFFIANCATO, di proprietà del
// daemon (vive anche ad app chiusa; un crash o un OOM di Metal non deve far
// cadere il daemon, come Ollama/LM Studio/Jan). Dipendenze TUTTE iniettabili
// (spawn, fetch, orologio, porta, file, log): nei test niente processi veri,
// niente porte, niente rete.
//
// - avvio su richiesta (ensureRunning): porta libera su 127.0.0.1 e chiave
//   casuale OGNI avvio, nell'env del figlio come LLAMA_API_KEY (LC4: mai in
//   argv, dove ps la mostrerebbe; nessun altro processo locale lo usa),
//   argomenti fissati dalla misura L1: --jinja -c 32768 -ngl 99 --parallel 1;
//   più chiamate concorrenti condividono lo stesso avvio;
// - spegnimento per inattività dopo 10 minuti senza richieste (come il
//   keep_alive di Ollama: libera ~4 GB) e SEMPRE con il daemon (stop);
// - crash: UN solo riavvio, poi un errore chiaro all'utente («memoria?»),
//   mai un loop di riavvii. Log in <data>/logs/llama-server.log a rotazione;
// - all'avvio del daemon uccide l'eventuale orfano del pidfile, SOLO se quel
//   pid è davvero un nostro llama-server (percorso dell'eseguibile), mai per
//   esempio l'llama-server di Homebrew.
//
// L2.5 (cache del prefisso): con --parallel 1 il KV del prefisso stabile si
// riusa da sé fra i passi dello stesso turno; nessun --slot-save-path.
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'

/** Il messaggio chiaro al secondo crash: mai un loop di riavvii. */
export const LOCAL_MODEL_CRASHED_ERROR =
  'il modello locale si è fermato (memoria?): riapri il modello integrato dalle Impostazioni per riavviarlo'

/** 10 minuti senza richieste → spegnimento (come il keep_alive di Ollama). */
export const IDLE_SHUTDOWN_MS = 10 * 60_000

/** /health ha 120 s per rispondere ok (il caricamento del GGUF è lento). */
export const HEALTH_TIMEOUT_MS = 120_000

/** Il log ruota oltre questa dimensione (llama-server.log → llama-server.log.1). */
const LOG_ROTATE_BYTES = 2_000_000

/** Il figlio spawn visto dal server (il sottoinsieme che serve, iniettabile). */
export interface SpawnedChild {
  pid: number
  kill(signal?: string): void
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  stdout?: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null
  stderr?: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null
}

export interface LocalModelServerDeps {
  now(): number
  sleep(ms: number): Promise<void>
  spawn(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }): SpawnedChild
  fetch(url: string, init?: { signal?: AbortSignal }): Promise<{ ok: boolean; status: number }>
  findFreePort(): Promise<number>
  newApiKey(): string
  /** il percorso dell'eseguibile di un pid (ps), null se non c'è */
  processPathOf(pid: number): Promise<string | null>
  /** uccide un pid NON nostro figlio (solo l'orfan del pidfile) */
  killPid(pid: number): void
  logLine(line: string): void
  readFileText(path: string): string | null
  writeFileText(path: string, text: string): void
  removeFile(path: string): void
  fileSize(path: string): number | null
}

export interface LocalModelStatus {
  running: boolean
  port: number | null
  startedAt: number | null
  lastError: string | null
}

export interface LocalModelServer {
  /** Avvia (una sola volta) se serve e torna { baseUrl, apiKey } per il turno. */
  ensureRunning(): Promise<{ baseUrl: string; apiKey: string }>
  /** Una richiesta al modello: posticipa lo spegnimento per inattività. */
  noteRequest(): void
  /** Spegne se sono passati 10 minuti dall'ultima richiesta (lo chiama il tick del daemon). */
  maybeShutdownIdle(): boolean
  /** Lo stato per la UI (scheda Integrato). */
  status(): LocalModelStatus
  /** Spegne sempre (fine del daemon, rimozione del modello). Idempotente. */
  stop(): Promise<void>
  /** All'avvio del daemon: uccide l'orfan del pidfile SOLO se è un nostro llama-server. */
  killOrphanIfOurs(): Promise<boolean>
}

/** La porta libera su 127.0.0.1: un listen(0) immediatamente chiuso. */
async function defaultFindFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/** Il log in <data>/logs/llama-server.log, a rotazione come gli altri log. */
function rotatingLog(logPath: string): (line: string) => void {
  return (line) => {
    try {
      if (existsSync(logPath) && statSync(logPath).size > LOG_ROTATE_BYTES) {
        renameSync(logPath, logPath + '.1') // il .1 vecchio si perde: due generazioni bastano
      }
      appendFileSync(logPath, line.endsWith('\n') ? line : line + '\n')
    } catch {
      // il log non deve mai fermare il modello
    }
  }
}

/**
 * Il server del modello integrato. `serverBin` è il binario ufficiale
 * fissato in scripts/llama-pin.json (vendor/llama/llama-server nell'app),
 * `modelFile` il GGUF del catalogo locale, `pidFile` nel data dir.
 */
export function createLocalModelServer(opts: {
  deps: LocalModelServerDeps
  serverBin: string
  modelFile: string
  pidFile: string
  /** per i test: dove va il log rotato (default <data>/logs/llama-server.log accanto al pidfile) */
  logPath?: string
  idleShutdownMs?: number
  healthTimeoutMs?: number
}): LocalModelServer {
  const { deps, serverBin, modelFile, pidFile } = opts
  const idleMs = opts.idleShutdownMs ?? IDLE_SHUTDOWN_MS
  const healthMs = opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS
  const log = opts.logPath ? rotatingLog(opts.logPath) : deps.logLine
  const writeLog = (line: string): void => { deps.logLine(line); log(line) }

  let child: SpawnedChild | null = null
  let baseUrl: string | null = null
  let apiKey: string | null = null
  let port: number | null = null
  let startedAt: number | null = null
  let lastRequestAt = 0
  let starting: Promise<{ baseUrl: string; apiKey: string }> | null = null
  let crashCount = 0
  let fatal: string | null = null
  let deliberateKill = false

  const writePidFile = (p: number): void => {
    try { deps.writeFileText(pidFile, JSON.stringify({ pid: child?.pid ?? null, port: p })) } catch { /* best effort */ }
  }
  const clearPidFile = (): void => {
    try { deps.removeFile(pidFile) } catch { /* già via */ }
  }

  const killChild = (): void => {
    if (!child) return
    deliberateKill = true
    try { child.kill('SIGTERM') } catch { /* già morto */ }
  }

  const startOnce = (): Promise<{ baseUrl: string; apiKey: string }> => {
    if (starting) return starting
    starting = (async () => {
      if (fatal) throw new Error(fatal)
      const p = await deps.findFreePort()
      const key = deps.newApiKey()
      const args = [
        '--host', '127.0.0.1', '--port', String(p), '--jinja', '-c', '32768',
        '-ngl', '99', '--parallel', '1', '-m', modelFile
      ]
      writeLog(`[local-model] starting ${serverBin} on port ${p}`)
      // LC4: la chiave NON sta nella riga di comando (ps la mostrerebbe a
      // ogni processo dell'utente) — passa SOLO nell'env del figlio come
      // LLAMA_API_KEY. Il tar del pin b12061 non è mai stato scaricato
      // (vendor/llama vuota), quindi l'opzione --api-key-file non si può
      // verificare contro il pin: si usa la variabile d'ambiente, che
      // llama-server legge per --api-key (confermata nell'help di un build
      // 12110 > 12061: «--api-key KEY (env: LLAMA_API_KEY)»).
      const c = deps.spawn(serverBin, args, {
        env: { ...process.env, LLAMA_API_KEY: key }
      })
      child = c
      deliberateKill = false
      c.on('exit', (code) => {
        writeLog(`[local-model] process exited (code ${code})`)
        if (child === c) {
          child = null
          baseUrl = null
          apiKey = null
          port = null
          clearPidFile()
          // crash VERO (non uno spegnimento voluto): UN riavvio concesso
          if (!deliberateKill) {
            crashCount++
            if (crashCount >= 2) fatal = LOCAL_MODEL_CRASHED_ERROR
          } else {
            crashCount = 0
          }
        }
      })
      c.on('error', (err) => writeLog(`[local-model] process error: ${err.message}`))
      c.stdout?.on('data', (chunk) => log(chunk.toString('utf8')))
      c.stderr?.on('data', (chunk) => log(chunk.toString('utf8')))
      // attesa di GET /health = ok fino a 120 s
      const deadline = deps.now() + healthMs
      for (;;) {
        try {
          const r = await deps.fetch(`http://127.0.0.1:${p}/health`)
          if (r.ok) break
        } catch {
          // ancora su: si riprova
        }
        if (child !== c) throw new Error('llama-server died during startup')
        if (deps.now() >= deadline) {
          killChild()
          child = null
          clearPidFile()
          throw new Error(`llama-server did not answer /health within ${Math.round(healthMs / 1000)} s`)
        }
        await deps.sleep(250)
      }
      if (child !== c) throw new Error('llama-server died during startup')
      port = p
      baseUrl = `http://127.0.0.1:${p}`
      apiKey = key
      startedAt = deps.now()
      lastRequestAt = deps.now()
      writePidFile(p)
      return { baseUrl, apiKey }
    })().finally(() => { starting = null })
    return starting
  }

  return {
    async ensureRunning() {
      if (fatal) throw new Error(fatal)
      if (baseUrl && apiKey && child) {
        lastRequestAt = deps.now()
        return { baseUrl, apiKey }
      }
      return await startOnce()
    },
    noteRequest() {
      lastRequestAt = deps.now()
    },
    maybeShutdownIdle() {
      if (!child) return false
      if (deps.now() - lastRequestAt < idleMs) return false
      writeLog('[local-model] idle shutdown (10 minutes without requests)')
      killChild()
      return true
    },
    status() {
      return {
        running: child !== null,
        port,
        startedAt,
        lastError: fatal
      }
    },
    async stop() {
      if (!child) { clearPidFile(); return }
      const c = child
      const exited = new Promise<void>((resolve) => {
        c.on('exit', () => resolve())
        setTimeout(resolve, 3000).unref?.()
      })
      killChild()
      await exited
      clearPidFile()
      fatal = null
      crashCount = 0
    },
    async killOrphanIfOurs() {
      const raw = deps.readFileText(pidFile)
      if (!raw) return false
      let pid = 0
      try {
        const j = JSON.parse(raw) as { pid?: unknown }
        if (typeof j.pid !== 'number') return false
        pid = j.pid
      } catch {
        clearPidFile()
        return false
      }
      const path = await deps.processPathOf(pid)
      if (path === null) {
        // processo morto: resta solo il pidfile da togliere
        clearPidFile()
        return false
      }
      // SOLO se l'eseguibile di quel pid è un NOSTRO llama-server (percorso
      // del bundle), mai l'llama-server di Homebrew o altro processo
      if (!/(^|\/)vendor\/llama\/llama-server$/.test(path.trim())) {
        writeLog(`[local-model] pid ${pid} in the pidfile is not our llama-server (${path}): leaving it alone`)
        return false
      }
      writeLog(`[local-model] orphan ${pid} (${path}): shutting it down`)
      deps.killPid(pid)
      clearPidFile()
      return true
    }
  }
}

// ---- le dipendenze di PRODUZIONE (il daemon le passa ai moduli veri) ----

/** La porta libera reale su 127.0.0.1. */
export const findFreePortProd: LocalModelServerDeps['findFreePort'] = defaultFindFreePort

/** Il percorso dell'eseguibile di un pid (ps -p PID -o comm=), null se morto. */
export async function processPathOfProd(pid: number): Promise<string | null> {
  return await new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'comm='], (err, stdout) => {
      if (err || !stdout.trim()) resolve(null)
      else resolve(stdout.trim())
    })
  })
}

/** Le dipendenze di produzione: file VERO nel data dir, log rotato, rete SOLO su 127.0.0.1. */
export function prodDeps(dataDir: string, logsDir: string): LocalModelServerDeps {
  const logPath = `${logsDir}/llama-server.log`
  const log = rotatingLog(logPath)
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    spawn: (cmd, args, opts) => {
      const c = nodeSpawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], detached: false })
      return c as unknown as SpawnedChild
    },
    fetch: (url, init) => fetch(url, init) as Promise<Response> as Promise<{ ok: boolean; status: number }>,
    findFreePort: defaultFindFreePort,
    newApiKey: () => randomBytes(24).toString('hex'),
    processPathOf: processPathOfProd,
    killPid: (pid) => { try { process.kill(pid, 'SIGTERM') } catch { /* già morto */ } },
    logLine: log,
    readFileText: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
    writeFileText: (p, t) => { try { writeFileSync(p, t, { mode: 0o600 }) } catch { /* best effort */ } },
    removeFile: (p) => { try { unlinkSync(p) } catch { /* già via */ } },
    fileSize: (p) => { try { return statSync(p).size } catch { return null } }
  }
}
