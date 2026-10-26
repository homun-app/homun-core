// Client WebSocket verso il daemon (lato main Electron): handshake HTTP
// Upgrade, frame client→server mascherati (RFC 6455), risposte ai ping.
// Puro I/O node: nessuna dipendenza da Electron, testabile con socket finti.
import { request } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { encodeFrame, decodeFrame, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT } from '../shared/ws'

export interface WsClientOptions {
  host: string
  port: number
  onText: (text: string) => void
  onClose: () => void
}

const CONNECT_TIMEOUT_MS = 5000

export class WsClient {
  private socket: Duplex | null = null
  private buf: Buffer = Buffer.alloc(0)
  private closed = false

  constructor(private readonly opts: WsClientOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64')
      const req = request({
        host: this.opts.host,
        port: this.opts.port,
        path: '/',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13'
        },
        timeout: CONNECT_TIMEOUT_MS
      })
      req.on('timeout', () => {
        req.destroy(new Error('timeout connessione al daemon'))
      })
      req.on('upgrade', (_res, socket) => {
        this.socket = socket
        socket.on('data', (d: Buffer) => this.feed(d))
        socket.on('close', () => this.destroy())
        socket.on('error', () => this.destroy())
        resolve()
      })
      req.on('error', (e) => reject(e))
      req.end()
    })
  }

  private feed(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d])
    for (;;) {
      let parsed: ReturnType<typeof decodeFrame>
      try {
        parsed = decodeFrame(this.buf)
      } catch {
        this.close()
        return
      }
      if (!parsed) return
      this.buf = parsed.rest
      const { opcode, payload } = parsed.frame
      if (opcode === OP_PING) {
        this.socket?.write(encodeFrame(OP_PONG, payload, false))
      } else if (opcode === OP_CLOSE) {
        this.socket?.write(encodeFrame(OP_CLOSE, payload, false))
        this.socket?.end()
        this.destroy()
      } else if (opcode === OP_TEXT) {
        this.opts.onText(payload.toString('utf8'))
      }
    }
  }

  send(text: string): void {
    if (this.closed || !this.socket) throw new Error('websocket non connesso')
    this.socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8'), true))
  }

  get isConnected(): boolean {
    return !this.closed && this.socket !== null
  }

  close(): void {
    if (this.closed || !this.socket) return
    this.socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0), true))
    this.socket.end()
    this.destroy()
  }

  private destroy(): void {
    if (this.closed) return
    this.closed = true
    this.socket?.destroy()
    this.opts.onClose()
  }
}
