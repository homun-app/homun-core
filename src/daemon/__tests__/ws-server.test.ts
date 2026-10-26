// Test del server WebSocket su loopback reale: connessioni non autenticate
// (R4) — niente hello entro il timeout → 4001; più di 64 KB accumulati
// (buffer + frammenti) prima dell'hello → 1009; dopo l'hello il limite
// pre-auth non si applica più (resta quello sui frame).
import { describe, expect, it, afterEach, vi } from 'vitest'
import { connect as tcpConnect, type Socket } from 'node:net'
import { startWsServer, type WsRpcServer } from '../ws-server'

const UPGRADE =
  'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'

/** Frame con FIN e opcode espliciti, non mascherato (il codec li accetta). */
function rawFrame(fin: boolean, opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  return Buffer.concat([header, payload])
}

/** Connessione grezza con handshake WebSocket completato. */
function wsConnect(port: number): Promise<{ sock: Socket; parts: Buffer[] }> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    const sock = tcpConnect({ port, host: '127.0.0.1' }, () => {
      sock.write(UPGRADE)
      resolve({ sock, parts })
    })
    sock.on('error', reject)
    sock.on('data', (d: Buffer) => parts.push(d))
  })
}

const whole = (parts: Buffer[]): Buffer => Buffer.concat(parts)

/** Codice del primo close frame ricevuto dopo l'handshake (null se nessuno). */
function closeCode(parts: Buffer[]): number | null {
  const b = whole(parts)
  const hs = b.indexOf('\r\n\r\n')
  if (hs === -1) return null
  for (let i = hs + 4; i + 4 <= b.length; i++) {
    if (b[i] === 0x88 && b[i + 1] === 0x02) return b.readUInt16BE(i + 2)
  }
  return null
}

let server: WsRpcServer | null = null
let socks: Socket[] = []
afterEach(async () => {
  for (const s of socks) s.destroy()
  socks = []
  await server?.close()
  server = null
})

describe('R4: connessioni non autenticate', () => {
  it('nessun hello entro il timeout → chiusura con 4001', async () => {
    server = await startWsServer({ token: 'tok', authTimeoutMs: 80 })
    const c = await wsConnect(server.port)
    socks.push(c.sock)
    // non viene inviato nessun hello: la connessione non resta appesa
    await vi.waitFor(() => expect(closeCode(c.parts)).toBe(4001))
    expect(server.hasUi()).toBe(false)
  })

  it('frammenti oltre 64 KB prima dell\'hello → chiusura con 1009', async () => {
    server = await startWsServer({ token: 'tok' }) // limiti di default
    const c = await wsConnect(server.port)
    socks.push(c.sock)
    // 5 frammenti da 15 KB senza FIN: 75 KB accumulati superano i 64 KB
    for (let i = 0; i < 5; i++) c.sock.write(rawFrame(false, i === 0 ? 0x1 : 0x0, Buffer.alloc(15 * 1024, 'x')))
    await vi.waitFor(() => expect(closeCode(c.parts)).toBe(1009))
    expect(server.hasUi()).toBe(false)
  })

  it('hello valido entro il timeout → autenticata; dopo l\'auth il limite pre-auth non scatta', async () => {
    server = await startWsServer({ token: 'tok', authTimeoutMs: 150 })
    const c = await wsConnect(server.port)
    socks.push(c.sock)
    c.sock.write(rawFrame(true, 0x1, Buffer.from('{"hello":true,"token":"tok"}')))
    await vi.waitFor(() => expect(whole(c.parts).includes('"hello":true,"ok":true')).toBe(true))
    expect(server.hasUi()).toBe(true)
    // un frame di 70 KB DOPO l'autenticazione resta entro i limiti attuali:
    // il metodo è sconosciuto → risposta d'errore, nessuna chiusura 1009
    const big = JSON.stringify({ rpc: true, id: 5, method: 'niente', params: ['x'.repeat(70_000)] })
    c.sock.write(rawFrame(true, 0x1, Buffer.from(big)))
    await vi.waitFor(() => expect(whole(c.parts).includes('metodo sconosciuto')).toBe(true))
    expect(closeCode(c.parts)).toBeNull()
  })
})
