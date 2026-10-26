// Server WebSocket del daemon: 127.0.0.1 su porta casuale. Il token (file
// 0600 nella directory dati) autentica la UI: senza hello valido la
// connessione viene chiusa e nessun metodo viene eseguito. Trasporta gli
// eventi push (broadcast) e le RPC in entrambe le direzioni (il daemon
// chiama la UI per le API host: notifiche, safeStorage, screen).
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { encodeFrame, decodeFrame, acceptKey, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT, OP_CONT, type WsFrame } from '../shared/ws'
import {
  parseMessage, isHelloAuthorized, serializeHelloOk, serializeEvent,
  serializeRpcOk, serializeRpcError
} from './rpc'
import type { SandbotEvent } from '../shared/types'

type MethodHandler = (params: unknown[]) => Promise<unknown> | unknown

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** Una connessione UI autenticata (o in attesa di hello). */
class Connection {
  authed = false
  private buf: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] | null = null
  private fragmentsOp = 0
  private closed = false
  readonly pending = new Map<number, Pending>()

  constructor(
    private readonly socket: Duplex,
    private readonly onText: (text: string) => void,
    private readonly onClose: () => void
  ) {
    socket.on('data', (d: Buffer) => this.feed(d))
    socket.on('close', () => this.destroy())
    socket.on('error', () => this.destroy())
  }

  private feed(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d])
    for (;;) {
      let parsed: { frame: WsFrame; rest: Buffer } | null
      try {
        parsed = decodeFrame(this.buf)
      } catch {
        this.close(1009)
        return
      }
      if (!parsed) return
      this.buf = parsed.rest
      const { opcode, payload, fin } = parsed.frame
      if (opcode === OP_PING) {
        this.socket.write(encodeFrame(OP_PONG, payload, false))
        continue
      }
      if (opcode === OP_PONG) continue
      if (opcode === OP_CLOSE) {
        this.socket.write(encodeFrame(OP_CLOSE, payload, false))
        this.socket.end()
        this.destroy()
        return
      }
      // frammentazione: concatena i continuation frame
      if (opcode === OP_TEXT || opcode === 0x2) {
        if (fin) this.onText(payload.toString('utf8'))
        else {
          this.fragments = [payload]
          this.fragmentsOp = opcode
        }
      } else if (opcode === OP_CONT && this.fragments) {
        this.fragments.push(payload)
        if (fin) {
          const whole = Buffer.concat(this.fragments)
          const op = this.fragmentsOp
          this.fragments = null
          if (op === OP_TEXT) this.onText(whole.toString('utf8'))
        }
      }
    }
  }

  send(text: string): void {
    if (!this.closed) this.socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8'), false))
  }

  ping(): void {
    if (!this.closed) this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0), false))
  }

  close(code = 1000): void {
    if (this.closed) return
    const body = Buffer.alloc(2)
    body.writeUInt16BE(code, 0)
    this.socket.write(encodeFrame(OP_CLOSE, body, false))
    this.socket.end()
    this.destroy()
  }

  destroy(): void {
    if (this.closed) return
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('connessione UI chiusa'))
    }
    this.pending.clear()
    this.socket.destroy()
    this.onClose()
  }
}

export interface WsRpcServer {
  readonly port: number
  /** true se c'è una UI connessa e autenticata. */
  hasUi(): boolean
  /** Invia un evento push a tutte le UI connesse. */
  broadcast(e: SandbotEvent): void
  /** RPC verso la UI (API host); fallisce se nessuna UI è connessa. */
  callUi(method: string, params?: unknown[]): Promise<unknown>
  /** Tabella dei metodi esposti alla UI. */
  methods: Record<string, MethodHandler>
  close(): Promise<void>
}

/**
 * Avvia il server. La porta è casuale (0): l'indirizzo reale finisce nel
 * file daemon-info insieme al token, come local-exec-daemon.json
 * nell'originale.
 */
export function startWsServer(opts: {
  host?: string
  port?: number
  token: string
  onUiChange?: (connected: boolean) => void
}): Promise<WsRpcServer> {
  const host = opts.host ?? '127.0.0.1'
  const conns = new Set<Connection>()
  let uiConn: Connection | null = null
  let nextCallId = 1

  const server: Server = createServer((_req: IncomingMessage, res) => {
    // nessuna pagina servita: solo WebSocket
    res.destroy()
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key']
    if (!key) {
      socket.destroy()
      return
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(String(key))}\r\n\r\n`
    )
    const conn = new Connection(
      socket,
      (text) => void handleMessage(conn, text),
      () => {
        conns.delete(conn)
        if (uiConn === conn) {
          uiConn = null
          opts.onUiChange?.(false)
        }
      }
    )
    conns.add(conn)
  })

  async function handleMessage(conn: Connection, text: string): Promise<void> {
    const msg = parseMessage(text)
    // handshake: il PRIMO messaggio deve essere un hello col token valido
    if (!conn.authed) {
      if (isHelloAuthorized(msg, opts.token)) {
        conn.authed = true
        if (uiConn && uiConn !== conn) uiConn.close(4000) // una sola UI per volta
        uiConn = conn
        conn.send(serializeHelloOk(true))
        opts.onUiChange?.(true)
      } else {
        conn.send(serializeHelloOk(false))
        conn.close(4001)
      }
      return
    }
    if (!msg || !('rpc' in msg)) return
    // risposta della UI a una nostra chiamata host.*
    if ('ok' in msg) {
      const p = conn.pending.get(msg.id)
      if (p) {
        conn.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error))
      }
      return
    }
    // richiesta RPC della UI
    const handler = impl.methods[msg.method]
    if (!handler) {
      conn.send(serializeRpcError(msg.id, `metodo sconosciuto: ${msg.method}`))
      return
    }
    try {
      const result = await handler(msg.params ?? [])
      conn.send(serializeRpcOk(msg.id, result))
    } catch (e) {
      conn.send(serializeRpcError(msg.id, e instanceof Error ? e.message : String(e)))
    }
  }

  const impl: WsRpcServer = {
    port: 0,
    methods: {},
    hasUi: () => uiConn !== null,
    broadcast(e: SandbotEvent): void {
      for (const c of conns) if (c.authed) c.send(serializeEvent(e))
    },
    async callUi(method: string, params: unknown[] = []): Promise<unknown> {
      if (!uiConn) throw new Error('UI non connessa')
      const id = nextCallId++
      const conn = uiConn
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          conn.pending.delete(id)
          reject(new Error(`RPC host.${method} scaduta`))
        }, 15_000)
        conn.pending.set(id, { resolve, reject, timer })
        conn.send(JSON.stringify({ rpc: true, id, method, params }))
      })
    },
    close(): Promise<void> {
      clearInterval(pinger)
      for (const c of conns) c.close(1000)
      return new Promise((resolve) => server.close(() => resolve()))
    }
  }

  // keepalive: individua le UI morte (app chiusa senza close handshake)
  const pinger = setInterval(() => {
    for (const c of conns) c.ping()
  }, 30_000)
  pinger.unref()

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('indirizzo websocket inaspettato'))
        return
      }
      ;(impl as { port: number }).port = addr.port
      resolve(impl)
    })
  })
}

/** Token casuale in esadecimale per l'autenticazione della UI. */
export function generateToken(): string {
  return randomBytes(32).toString('hex')
}
