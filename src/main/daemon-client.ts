// Client del daemon nel main Electron: assicura che il processo esista (lo
// avvia con l'eseguibile Electron in ELECTRON_RUN_AS_NODE=1 se non attivo),
// si connette via WebSocket col token di daemon.json, inoltra le RPC della
// UI, riceve gli eventi push e risponde alle chiamate host.* del daemon
// (notifiche native, safeStorage, screen). Riconnette automaticamente.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { openSync, closeSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { WsClient } from './ws-client'
import { readDaemonInfo, removeDaemonInfo, pidAlive, releaseDaemonLock, type DaemonInfo } from '../daemon/daemon-files'
import { parseMessage, serializeRpcRequest, serializeRpcOk, serializeRpcError, serializeHello } from '../daemon/rpc'
import { dataDir } from './store/db'
import type { SandbotEvent } from '../shared/types'

const RECONNECT_DELAY_MS = 2000
const SPAWN_TIMEOUT_MS = 15_000

/** Percorso del bundle del daemon: in dev sta accanto a out/main/index.js, nella build impacchettata è unpacked fuori dall'asar (ELECTRON_RUN_AS_NODE non legge gli asar). */
export function daemonEntryPath(): string {
  const beside = join(__dirname, 'daemon.js')
  if (existsSync(beside) && !process.resourcesPath) return beside
  if (process.resourcesPath) {
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'main', 'daemon.js')
    if (existsSync(unpacked)) return unpacked
  }
  return beside
}

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

/**
 * Avvia il daemon se non è già attivo e ne aspetta il daemon.json fresco.
 * Un daemon.json con pid morto o con pid appartenente ad altro processo è
 * stantio: viene rimosso (col lock) e il daemon riparte.
 */
export async function ensureDaemonRunning(): Promise<DaemonInfo> {
  const dir = dataDir()
  const logPath = join(dir, 'daemon.log')
  const existing = readDaemonInfo(dir)
  if (existing && pidAlive(existing.pid)) {
    const cmd = existing.pid === process.pid ? '' : await processCommand(existing.pid)
    // il pid è vivo ed è un nostro daemon (node <bundle> --data …): riusalo
    if (existing.pid === process.pid || (cmd && cmd.includes('daemon') && cmd.includes('sandbot'))) {
      return existing
    }
    // pid riusato dal SO per un altro processo: info stantia
    removeDaemonInfo(dir)
    releaseDaemonLock(dir)
  } else if (existing) {
    removeDaemonInfo(dir)
    releaseDaemonLock(dir)
  }

  const startedAt = Date.now()
  const out = openSync(logPath, 'a')
  try {
    const child: ChildProcess = spawn(process.execPath, [daemonEntryPath(), '--data', dir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SANDBOT_DATA_DIR: dir },
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
    if (info && info.startedAt >= startedAt) return info
    if (Date.now() > deadline) throw new Error('il daemon non ha scritto daemon.json entro il timeout (vedi data/daemon.log)')
  }
}

type HostHandler = (params: unknown[]) => unknown

/**
 * Connessione al daemon. call() aspetta la connessione (e il daemon) prima
 * di inviare: la UI può invocare appena carica.
 */
export class DaemonClient {
  private ws: WsClient | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private readonly listeners = new Set<(e: SandbotEvent) => void>()
  private readonly hostHandlers = new Map<string, HostHandler>()
  private connecting: Promise<void> | null = null
  private stopped = false
  private helloDone: (() => void) | null = null
  private helloFail: ((e: Error) => void) | null = null

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
        const info = await ensureDaemonRunning()
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
    const ws = new WsClient({
      host: '127.0.0.1',
      port: info.port,
      onText: (text) => this.handleText(text),
      onClose: () => this.handleClose()
    })
    await ws.connect()
    this.ws = ws
    ws.send(serializeHello(info.token))
    // il token è valido se l'hello arriva prima della chiusura
    const guard = setTimeout(() => this.helloFail?.(new Error('handshake col daemon scaduto')), SPAWN_TIMEOUT_MS)
    try {
      await handshake
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
