// Client del daemon nel main Electron: assicura che il processo esista (lo
// avvia come STESSO eseguibile Electron con --homun-daemon — fase rilascio
// A1: niente più ELECTRON_RUN_AS_NODE, il fuse RunAsNode va spento nella
// build pubblicata), si connette via WebSocket col token di daemon.json,
// inoltra le RPC della UI, riceve gli eventi push e risponde alle chiamate
// host.* del daemon (notifiche native, safeStorage, screen).
//
// Fase rilascio (A2): se il daemon attivo è di versione o build DIVERSA
// (dopo un aggiornamento), la UI gli chiede di uscire BENE (RPC
// daemon:restart: smette di prendere job, dà ai turni in corso fino a 10 s
// per chiudere — la coda è durevole — ed esce con 0) e poi lo rilancia.
// Riconnette automaticamente.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { openSync, closeSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { WsClient } from './ws-client'
import { readDaemonInfo, removeDaemonInfo, pidAlive, releaseDaemonLock, daemonMatchesBuild, type DaemonInfo, type DaemonBuild } from '../daemon/daemon-files'
import { parseMessage, serializeRpcRequest, serializeRpcOk, serializeRpcError, serializeHello } from '../daemon/rpc'
import { daemonSpawnSpec, isDaemonCommandLine, isLegacyDaemonCommandLine, DAEMON_FLAG } from './mode'
import { daemonSpawnContext } from './daemon-context'
import { dataDir } from './store/db'
import type { SandbotEvent } from '../shared/types'

const RECONNECT_DELAY_MS = 2000
const SPAWN_TIMEOUT_MS = 15_000
/** Quanto si aspetta l'uscita del daemon vecchio dopo la richiesta (drain A2 + margine). */
const RESTART_WAIT_MS = 20_000

/** Riga di comando di un processo (per capire se un pid è davvero il nostro daemon). */
function processCommand(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim())
    })
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** Aspetta che il pid del daemon sparisca (o che daemon.json cambi custode). */
export async function waitDaemonPidGone(dir: string, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    const info = readDaemonInfo(dir)
    if (info && info.pid !== pid) return true
    await sleep(200)
  }
  return !pidAlive(pid)
}

/**
 * Chiede a un daemon VIVO di uscire bene per l'aggiornamento (A2): una
 * connessione ws di una sola RPC, hello col token, daemon:restart, poi si
 * aspetta l'uscita. Se il daemon non risponde, SIGTERM (la coda è durevole).
 */
export async function askDaemonToRestart(dir: string, info: DaemonInfo, timeoutMs = RESTART_WAIT_MS): Promise<void> {
  let replied: (() => void) | null = null
  const reply = new Promise<void>((resolve) => {
    replied = resolve
  })
  const ws = new WsClient({
    host: '127.0.0.1',
    port: info.port,
    onText: (text) => {
      const msg = parseMessage(text)
      if (msg && 'rpc' in msg) replied?.()
    },
    onClose: () => replied?.()
  })
  try {
    await ws.connect()
    ws.send(serializeHello(info.token))
    ws.send(serializeRpcRequest(1, 'daemon:restart', []))
    // la risposta può arrivare o meno (daemon occupato, token vecchio): si
    // aspetta poco, poi conta solo l'uscita del processo
    await Promise.race([reply, sleep(3_000)])
  } catch {
    // daemon già andato o irraggiungibile: sotto si valuta il pid
  }
  const gone = await waitDaemonPidGone(dir, info.pid, timeoutMs)
  ws.close()
  if (!gone && pidAlive(info.pid)) {
    try {
      process.kill(info.pid, 'SIGTERM')
    } catch {
      // già uscito
    }
    await waitDaemonPidGone(dir, info.pid, 5000)
  }
}

/**
 * Avvia il daemon se non è già attivo e ne aspetta il daemon.json fresco.
 * Un daemon.json con pid morto o con pid appartenente ad altro processo è
 * stantio: viene rimosso (col lock) e il daemon riparte. Un daemon VIVO ma
 * di versione/build diversa (A2) — o VECCHIO stile (fase ≤16c) — esce bene
 * e viene rilanciato.
 */
export async function ensureDaemonRunning(expected?: DaemonBuild): Promise<DaemonInfo> {
  const dir = dataDir()
  const logPath = join(dir, 'daemon.log')
  const existing = readDaemonInfo(dir)
  if (existing && pidAlive(existing.pid)) {
    const cmd = existing.pid === process.pid ? '' : await processCommand(existing.pid)
    if (existing.pid === process.pid) return existing
    if (cmd && isLegacyDaemonCommandLine(cmd)) {
      // daemon della ≤16c (ELECTRON_RUN_AS_NODE): fermalo, entra quello nuovo
      await askDaemonToRestart(dir, existing)
    } else if (cmd && isDaemonCommandLine(cmd)) {
      if (!expected || daemonMatchesBuild(existing, expected)) return existing
      // versione/build diversi: il daemon esce BENE (A2) e si rilancia
      await askDaemonToRestart(dir, existing)
    } else {
      // pid riusato dal SO per un altro processo: info stantia
      removeDaemonInfo(dir)
      releaseDaemonLock(dir)
    }
  } else if (existing) {
    removeDaemonInfo(dir)
    releaseDaemonLock(dir)
  }

  const startedAt = Date.now()
  const out = openSync(logPath, 'a')
  try {
    const ctx = daemonSpawnContext()
    const spec = daemonSpawnSpec({ execPath: process.execPath, isPackaged: ctx.isPackaged, appPath: ctx.appPath, env: process.env })
    const child: ChildProcess = spawn(spec.command, spec.args, {
      env: spec.env,
      detached: true,
      stdio: ['ignore', out, out]
    })
    child.unref()
  } finally {
    closeSync(out)
  }

  const deadline = Date.now() + SPAWN_TIMEOUT_MS
  for (;;) {
    await sleep(200)
    const info = readDaemonInfo(dir)
    if (info && info.startedAt >= startedAt) {
      if (expected && !daemonMatchesBuild(info, expected)) {
        // è partito ma non è della build attesa (es. spawn che ha riusato un
        // vecchio bundle): si riparte dal principio una volta
        if (pidAlive(info.pid)) await askDaemonToRestart(dir, info)
        continue
      }
      return info
    }
    if (Date.now() > deadline) throw new Error('il daemon non ha scritto daemon.json entro il timeout (vedi data/daemon.log)')
  }
}

type HostHandler = (params: unknown[]) => unknown

/** Connessione ws verso il daemon (l'interfaccia di WsClient, iniettabile nei test). */
export interface WsLike {
  connect(): Promise<void>
  send(text: string): void
  close(): void
  isConnected: boolean
}

export interface DaemonClientDeps {
  /** Fabbrica della connessione ws (default: WsClient reale su 127.0.0.1). */
  makeWs?: (opts: { host: string; port: number; onText: (text: string) => void; onClose: () => void }) => WsLike
  /** Assicura il daemon attivo e ne restituisce indirizzo+token (default: ensureDaemonRunning). */
  ensure?: (expected?: DaemonBuild) => Promise<DaemonInfo>
  /** Versione/build attesa del daemon (A2; default: il contesto del main). */
  expectedBuild?: DaemonBuild
}

/**
 * Connessione al daemon. call() aspetta la connessione (e il daemon) prima
 * di inviare: la UI può invocare appena carica.
 *
 * Residuo fase 4 (0b): alla RICONNESSIONE (non alla prima connessione)
 * dispatcha l'evento 'reconnected' — la UI ricarica agenti ed entry
 * dell'agente selezionato, altrimenti resterebbe ferma al contenuto di
 * prima della disconnessione finché non riselezioni l'agente.
 */
export class DaemonClient {
  private ws: WsLike | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private readonly listeners = new Set<(e: SandbotEvent) => void>()
  private readonly hostHandlers = new Map<string, HostHandler>()
  private connecting: Promise<void> | null = null
  private stopped = false
  private helloDone: (() => void) | null = null
  private helloFail: ((e: Error) => void) | null = null
  private everConnected = false
  private readonly makeWs: NonNullable<DaemonClientDeps['makeWs']>
  private readonly ensure: NonNullable<DaemonClientDeps['ensure']>
  private readonly expectedBuild: DaemonBuild

  constructor(deps: DaemonClientDeps = {}) {
    this.makeWs = deps.makeWs ?? ((opts) => new WsClient(opts))
    this.ensure = deps.ensure ?? ensureDaemonRunning
    const ctx = daemonSpawnContext()
    this.expectedBuild = deps.expectedBuild ?? { version: ctx.version, build: ctx.buildId }
  }

  /** Registra un metodo host.* che il daemon può chiamare quando la UI è aperta. */
  registerHost(method: string, handler: HostHandler): void {
    this.hostHandlers.set(method, handler)
  }

  onEvent(cb: (e: SandbotEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Prima connessione (avvia il daemon se serve); le successive sono automatiche. */
  start(): Promise<void> {
    return this.ensureConnected()
  }

  stop(): void {
    this.stopped = true
    this.ws?.close()
  }

  get connected(): boolean {
    return this.ws?.isConnected ?? false
  }

  /** Aspetta che il processo del daemon esca (A8: prima di installare un aggiornamento). */
  async waitDaemonExit(timeoutMs = 15_000): Promise<void> {
    const dir = dataDir()
    const info = readDaemonInfo(dir)
    if (info) await waitDaemonPidGone(dir, info.pid, timeoutMs)
  }

  private ensureConnected(): Promise<void> {
    if (this.connected) return Promise.resolve()
    if (!this.connecting) {
      this.connecting = this.connectWithRetry().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connectWithRetry(): Promise<void> {
    while (!this.stopped) {
      try {
        const info = await this.ensure(this.expectedBuild)
        await this.connectOnce(info)
        return
      } catch (e) {
        console.error('[sandbot] connessione al daemon fallita:', e instanceof Error ? e.message : e)
        await sleep(RECONNECT_DELAY_MS)
      }
    }
    throw new Error('client fermato')
  }

  private async connectOnce(info: DaemonInfo): Promise<void> {
    const handshake = new Promise<void>((resolve, reject) => {
      this.helloDone = resolve
      this.helloFail = reject
    })
    const ws = this.makeWs({
      host: '127.0.0.1',
      port: info.port,
      onText: (text) => this.handleText(text),
      onClose: () => this.handleClose()
    })
    await ws.connect()
    this.ws = ws
    ws.send(serializeHello(info.token))
    // il token è valido se l'hello arriva prima della chiusura
    // (fase 17c correzioni D2: errore d'avvio per lo sviluppatore, inglese come gli altri log)
    const guard = setTimeout(() => this.helloFail?.(new Error('daemon handshake timed out')), SPAWN_TIMEOUT_MS)
    try {
      await handshake
      // 0b: alla riconnessione la UI ricarica transcript e agenti
      if (this.everConnected) this.dispatchEvent({ type: 'reconnected' })
      this.everConnected = true
    } finally {
      clearTimeout(guard)
      this.helloDone = null
      this.helloFail = null
    }
  }

  private handleText(text: string): void {
    const msg = parseMessage(text)
    if (!msg) return
    if ('hello' in msg) {
      // risposta al nostro hello (token rifiutato → chiusura a breve)
      if ('ok' in msg && msg.ok) this.helloDone?.()
      else this.helloFail?.(new Error('token rifiutato dal daemon'))
      return
    }
    if ('ev' in msg) return this.dispatchEvent(msg.ev)
    if ('rpc' in msg) {
      if ('ok' in msg) {
        // risposta a una nostra chiamata
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error))
        return
      }
      // richiesta del daemon (host.*)
      void this.handleHostRequest(msg.id, msg.method, msg.params ?? [])
    }
  }

  private dispatchEvent(ev: SandbotEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(ev)
      } catch (e) {
        console.error('[sandbot] listener evento:', e)
      }
    }
  }

  private async handleHostRequest(id: number, method: string, params: unknown[]): Promise<void> {
    const handler = this.hostHandlers.get(method)
    if (!handler) {
      this.ws?.send(serializeRpcError(id, `metodo host sconosciuto: ${method}`))
      return
    }
    try {
      this.ws?.send(serializeRpcOk(id, await handler(params)))
    } catch (e) {
      this.ws?.send(serializeRpcError(id, e instanceof Error ? e.message : String(e)))
    }
  }

  private handleClose(): void {
    if (this.ws) this.ws = null
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('connessione al daemon persa'))
    }
    this.pending.clear()
    if (!this.stopped) {
      // riconnessione (il daemon potrebbe essere morto: ensure lo riavvia)
      setTimeout(() => void this.ensureConnected().catch(() => undefined), RECONNECT_DELAY_MS)
    }
  }

  call(method: string, params: unknown[] = []): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error('client fermato'))
    return this.ensureConnected().then(
      () =>
        new Promise((resolve, reject) => {
          const id = this.nextId++
          const timer = setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`RPC ${method} scaduta`))
          }, 120_000)
          this.pending.set(id, { resolve, reject, timer })
          try {
            this.ws!.send(serializeRpcRequest(id, method, params))
          } catch (e) {
            this.pending.delete(id)
            clearTimeout(timer)
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
    )
  }
}

/** Rimuove i file di stato del daemon (test). */
export function resetDaemonFiles(): void {
  rmSync(join(dataDir(), 'daemon.json'), { force: true })
}

/** Il flag della modalità daemon, esposto per i test e i probe (A1). */
export { DAEMON_FLAG }
