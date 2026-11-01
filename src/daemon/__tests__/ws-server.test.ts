// Test del server WebSocket su loopback reale: connessioni non autenticate
// (R4) — niente hello entro il timeout → 4001; più di 64 KB accumulati
// (buffer + frammenti) prima dell'hello → 1009; dopo l'hello il limite
// pre-auth non si applica più (resta quello sui frame).
import { describe, expect, it, afterEach, vi } from 'vitest'
import { connect as tcpConnect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { startWsServer, type WsRpcServer } from '../ws-server'
// fase 17c: la lingua dell'interfaccia dei test è l'italiano (i testi erano italiani prima)
import { setSetting } from '../../main/store/db'
setSetting('ui.activeLanguage', 'it')

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

// ---- fase 19a correzioni (L8): upgrade con percorso malformato NON uccide il daemon ----

describe('L8: /screen/<cap> malformato → 404, nessuna eccezione, il server resta vivo', () => {
  /** Richiesta di upgrade GREZZA col percorso voluto. */
  const upgradeAt = (path: string): string =>
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'

  /** Apre una connessione, scrive l'upgrade e raccoglie la risposta del server. */
  const rawUpgrade = (port: number, path: string): Promise<{ parts: Buffer[]; sock: Socket }> =>
    new Promise((resolve, reject) => {
      const parts: Buffer[] = []
      const sock = tcpConnect({ port, host: '127.0.0.1' }, () => {
        sock.write(upgradeAt(path))
        resolve({ parts, sock })
      })
      sock.on('error', reject)
      sock.on('data', (d: Buffer) => parts.push(d))
    })

  it('/screen/%, /screen/%zz, /screen/a/b e 44 caratteri → 404, NESSUNA eccezione, seconda connessione OK', async () => {
    // prima della correzione: decodeURIComponent('/screen/%') lanciava URIError
    // DENTRO l'handler dell'upgrade e il processo moriva (nessun gestore
    // uncaughtException). Il test resta in ascolto e verifica che non arrivi nulla.
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown): void => { uncaught.push(e) }
    process.on('uncaughtException', onUncaught)
    const seen: string[] = []
    const caps: string[] = []
    try {
      server = await startWsServer({
        token: 'tok',
        onScreenUpgrade: (cap) => { caps.push(cap) }
      })
      for (const bad of ['/screen/%', '/screen/%zz', '/screen/a/b', '/screen/' + 'A'.repeat(44), '/screen/' + '='.repeat(43)]) {
        const c = await rawUpgrade(server.port, bad)
        socks.push(c.sock)
        await vi.waitFor(() => expect(whole(c.parts).toString('latin1').startsWith('HTTP/1.1 404')).toBe(true))
        seen.push(bad)
        // il gestore dello schermo NON è mai chiamato
        expect(caps).toEqual([])
      }
      // il server continua a rispondere: il canale UI di sempre fa l'upgrade
      const ui = await wsConnect(server.port)
      socks.push(ui.sock)
      await vi.waitFor(() => expect(whole(ui.parts).toString('latin1').includes('101 Switching Protocols')).toBe(true))
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    expect(seen).toHaveLength(5)
    expect(uncaught).toEqual([])
  })

  it('un percorso di capability BEN FORMATO (43 caratteri base64url) passa al gestore', async () => {
    const caps: string[] = []
    server = await startWsServer({
      token: 'tok',
      onScreenUpgrade: (cap, _req, socket) => {
        caps.push(cap)
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: ' + 'x'.repeat(10) + '\r\n\r\n')
        socket.destroy()
      }
    })
    // la VERA forma: base64url di 32 byte (43 caratteri), come screenOpen
    const good = randomBytes(32).toString('base64url')
    expect(good).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const c = await rawUpgrade(server.port, `/screen/${good}`)
    socks.push(c.sock)
    await vi.waitFor(() => expect(caps).toEqual([good]))
    expect(whole(c.parts).toString('latin1')).toContain('101 Switching Protocols')
  })
})
