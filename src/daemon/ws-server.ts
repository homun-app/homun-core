// Server WebSocket del daemon: 127.0.0.1 su porta casuale. Il token (file
// 0600 nella directory dati) autentica la UI: senza hello valido la
// connessione viene chiusa e nessun metodo viene eseguito. Trasporta gli
// eventi push (broadcast) e le RPC in entrambe le direzioni (il daemon
// chiama la UI per le API host: notifiche, safeStorage, screen).
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { encodeFrame, decodeFrame, acceptKey, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT, OP_CONT, type WsFrame } from '../shared/ws'
import {
  parseMessage, isHelloAuthorized, serializeHelloOk, serializeEvent,
  serializeRpcOk, serializeRpcError
} from './rpc'
import type { SandbotEvent } from '../shared/types'
// fase 17c (C3): confine RPC — gli UiError si traducono qui per la UI
import { uiLanguage, uiText, formatUi } from '../main/ui-language'
import { UI } from '../shared/ui-messages'
import { UiError } from '../shared/ui-text'

type MethodHandler = (params: unknown[]) => Promise<unknown> | unknown

/** Tempo concesso per l'hello valido: dopo, la connessione è chiusa (4001). */
const AUTH_TIMEOUT_MS = 5_000
/** Tetto pre-autenticazione: buffer + frammenti accumulati non oltre 64 KB. */
const PRE_AUTH_MAX_BYTES = 64 * 1024

/**
 * Fase 19a correzioni (L8): il percorso dell'endpoint dello schermo è valido
 * SOLO in questa forma — capability base64url di 32 byte (43 caratteri), il
 * percorso NON si decodifica MAI: `decodeURIComponent('/screen/%')` lanciava
 * URIError DENTRO l'handler dell'upgrade e, senza un gestore
 * uncaughtException, il processo moriva (lo può tentare qualunque pagina nel
 * browser dell'utente). Per tutto il resto: 404 e chiusura.
 */
export const SCREEN_CAP_PATH_RE = /^\/screen\/[A-Za-z0-9_-]{43}$/

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
  private authTimer: NodeJS.Timeout | null = null
  readonly pending = new Map<number, Pending>()

  constructor(
    private readonly socket: Duplex,
    private readonly onText: (text: string) => void,
    private readonly onClose: () => void,
    private readonly limits: { authTimeoutMs: number; preAuthMaxBytes: number }
  ) {
    socket.on('data', (d: Buffer) => this.feed(d))
    socket.on('close', () => this.destroy())
    socket.on('error', () => this.destroy())
    // una connessione che non si autentica non resta appesa
    this.authTimer = setTimeout(() => {
      if (!this.authed) this.close(4001)
    }, this.limits.authTimeoutMs)
    this.authTimer.unref()
  }

  /** Hello valido ricevuto: ferma il timer e azzera il tetto pre-auth. */
  markAuthed(): void {
    this.authed = true
    if (this.authTimer) {
      clearTimeout(this.authTimer)
      this.authTimer = null
    }
  }

  /** Byte accumulati in attesa di parse o di frammenti completi. */
  private preAuthBytes(): number {
    return this.buf.length + (this.fragments?.reduce((n, f) => n + f.length, 0) ?? 0)
  }

  feed(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d])
    // prima dell'autenticazione nemmeno il buffer può crescire senza limite
    if (!this.authed && this.preAuthBytes() > this.limits.preAuthMaxBytes) {
      this.close(1009)
      return
    }
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
        if (!this.authed && this.preAuthBytes() > this.limits.preAuthMaxBytes) {
          this.close(1009)
          return
        }
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
    this.closed = true
    const body = Buffer.alloc(2)
    body.writeUInt16BE(code, 0)
    this.socket.write(encodeFrame(OP_CLOSE, body, false))
    // niente destroy qui: end() svuota il write buffer così il close frame
    // arriva davvero; l'evento 'close' della socket chiamerà destroy()
    this.socket.end()
    this.teardown()
    this.onClose()
  }

  destroy(): void {
    if (this.closed) return
    this.closed = true
    this.teardown()
    this.socket.destroy()
    this.onClose()
  }

  private teardown(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer)
      this.authTimer = null
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('connessione UI chiusa'))
    }
    this.pending.clear()
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
  /** Tempo concesso per l'hello valido prima della chiusura (default 5s). */
  authTimeoutMs?: number
  /** Tetto pre-autenticazione in byte, buffer + frammenti (default 64 KB). */
  preAuthMaxBytes?: number
  /**
   * Fase 6: gestore delle richieste HTTP ordinarie (i webhook dei trigger,
   * POST /hooks/<routineId>) sulla stessa porta del WebSocket. true se ha
   * risposto; false/undefined → la connessione viene chiusa come oggi.
   */
  httpHandler?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>
  /**
   * Fase 19a (V3.2): l'endpoint dello SCHERMO del bot. Gli upgrade WebSocket
   * con percorso /screen/<cap> passano a questo gestore (il ponte binario con
   * il socket unix del desktop); QUALUNQUE altro percorso resta il canale UI
   * di oggi. Il gestore consuma la capability monouso e risponde da sé agli
   * upgrade non validi.
   */
  onScreenUpgrade?: (cap: string, req: IncomingMessage, socket: Duplex, head: Buffer) => void
}): Promise<WsRpcServer> {
  const host = opts.host ?? '127.0.0.1'
  const limits = {
    authTimeoutMs: opts.authTimeoutMs ?? AUTH_TIMEOUT_MS,
    preAuthMaxBytes: opts.preAuthMaxBytes ?? PRE_AUTH_MAX_BYTES
  }
  const conns = new Set<Connection>()
  let uiConn: Connection | null = null
  let nextCallId = 1

  const server: Server = createServer((req: IncomingMessage, res) => {
    // nessuna pagina servita: solo WebSocket e i webhook dei trigger (fase 6)
    if (opts.httpHandler) {
      void Promise.resolve(opts.httpHandler(req, res)).then((handled) => {
        if (!handled) res.destroy()
      })
      return
    }
    res.destroy()
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // fase 19a (V3.2): /screen/<capability> è il ponte binario con il desktop
    // del bot (capability monouso, la consuma il gestore); tutto il resto è il
    // canale UI di sempre
    // correzione L8: NESSUNA decodifica del percorso — valido SOLO se è
    // ESATTAMENTE /screen/<43 caratteri base64url> (SCREEN_CAP_PATH_RE);
    // `/screen/%` e compagnia fanno 404 e chiusura, senza eccezioni
    const path = req.url ?? '/'
    if (opts.onScreenUpgrade && path.startsWith('/screen/')) {
      if (!SCREEN_CAP_PATH_RE.test(path)) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        socket.destroy()
        return
      }
      opts.onScreenUpgrade(path.slice('/screen/'.length), req, socket, head)
      return
    }
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
      },
      limits
    )
    // byte arrivati insieme alla richiesta di upgrade (stesso segmento TCP):
    // node li consegna qui, non con l'evento 'data'
    if (head.length > 0) conn.feed(head)
    conns.add(conn)
  })

  async function handleMessage(conn: Connection, text: string): Promise<void> {
    const msg = parseMessage(text)
    // handshake: il PRIMO messaggio deve essere un hello col token valido
    if (!conn.authed) {
      if (isHelloAuthorized(msg, opts.token)) {
        conn.markAuthed()
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
      // fase 17c (C3): errore RPC nel catalogo UI
      conn.send(serializeRpcError(msg.id, uiText(UI.rpcUnknownMethod, { method: msg.method })))
      return
    }
    try {
      const result = await handler(msg.params ?? [])
      conn.send(serializeRpcOk(msg.id, result))
    } catch (e) {
      // fase 17c (C3): gli UiError (testo inglese per il modello) qui diventano
      // il testo della lingua dell'interfaccia: questo è il confine con la UI
      conn.send(serializeRpcError(msg.id, e instanceof UiError ? formatUi(e.uiText, uiLanguage()) : e instanceof Error ? e.message : String(e)))
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
