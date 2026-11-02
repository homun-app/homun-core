// Fase 19a (V9): il ponte dello schermo — con SANDBOT_TEST_FAKE_SCREEN_SOCKET
// un finto server RFB su un socket UNIX del test (handshake "RFB 003.008\n" e
// echo dei byte): la capability è MONOUSO e scade (orologio finto), una
// capability view NON avvia il x11vnc di controllo, i frame BINARI passano
// intatti nei due sensi e la chiusura del browser chiude le connessioni.
// Niente Docker: il ponte gira con `node -e` sul socket locale del test.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { connect as tcpConnect } from 'node:net'
import { startWsServer, type WsRpcServer } from '../ws-server'
import { randomBytes } from 'node:crypto'

// i flag di test vanno impostati prima dell'import: il finto browser MCP
// (come nell'eval) rende disponibile il browser senza docker; il finto
// schermo sostituisce docker exec con un socket unix locale del test
const FAKE_DIR = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-screen-'))
process.env.SANDBOT_TEST_FAKE_SCREEN_SOCKET = FAKE_DIR
process.env.SANDBOT_TEST_FAKE_BROWSER_MCP ??= new URL('../../../scripts/fake-browser-mcp.mjs', import.meta.url).pathname

// i comandi docker del modulo screen (x11vnc di controllo, attesa socket):
// registrati, così si vede QUALI argv partono davvero (col finto schermo non
// dovrebbero essercene affatto)
const dockerCalls = vi.hoisted(() => ({ argvs: [] as string[][] }))
vi.mock('../../main/sandbox', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runDockerRaw: async (argv: string[]) => {
    dockerCalls.argvs.push(argv)
    return { stdout: '42\n', stderr: '', exitCode: 0, signal: null, trimmed: false }
  }
}))

import {
  initScreen, resetScreenForTests, screenOpen, consumeScreenCap, handleScreenUpgrade,
  screenRelease, screenBrowserClosed, markTakeoverPending, takeoverPendingOf,
  userControlActive, browserHoldMs, tickScreen, TAKEOVER_DONE_TEXT,
  SCREEN_CAP_TTL_MS, TAKEOVER_TIMEOUT_MS, SCREEN_HOLD_MAX_MS
} from '../../main/agent/screen'
import { UiError } from '../../shared/ui-text'
import { resetBrowserForTests } from '../../main/agent/browser'
import { TEST_TMP_BASE } from '../../test-tmp'

/** Un finto server RFB su socket unix: handshake RFB + echo dei byte. */
function fakeRfbServer(path: string): Promise<{ close: () => void; received: Buffer[]; sockets: Socket[] }> {
  const received: Buffer[] = []
  const sockets: Socket[] = []
  return new Promise((resolve) => {
    const server = createServer((sock) => {
      sockets.push(sock)
      sock.on('data', (d: Buffer) => {
        received.push(d)
        sock.write(d) // echo: così si prova ENTRAMBE le direzioni
      })
    })
    server.listen(path, () => {
      resolve({
        close: () => new Promise<void>((r) => server.close(() => r())),
        received,
        sockets
      })
    })
  })
}

/** Handshake di upgrade WebSocket con capability e subprotocollo binary. */
const upgradeWith = (cap: string) =>
  'GET /screen/' + cap + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
  'Sec-WebSocket-Protocol: binary\r\n\r\n'

/** Frame client→server MASCHERATO (RFC 6455 §5.1). */
function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const key = randomBytes(4)
  const masked = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ key[i % 4]!
  const header = Buffer.alloc(2)
  header[0] = 0x80 | opcode
  header[1] = 0x80 | payload.length
  return Buffer.concat([header, key, masked])
}

/** Il primo frame binario non mascherato dopo l'handshake (o null). */
function firstBinaryFrame(parts: Buffer[]): Buffer | null {
  const b = Buffer.concat(parts)
  const hs = b.indexOf('\r\n\r\n')
  if (hs === -1) return null
  for (let i = hs + 4; i + 2 <= b.length;) {
    const fin = (b[i]! & 0x80) !== 0
    const opcode = b[i]! & 0x0f
    const masked = (b[i + 1]! & 0x80) !== 0
    const len = b[i + 1]! & 0x7f
    if (b.length < i + 2 + len) return null
    if (fin && opcode === 0x2 && !masked) return b.subarray(i + 2, i + 2 + len)
    i += 2 + len + (masked ? 4 : 0)
  }
  return null
}

describe('fase 19a (V9): il ponte dello schermo', () => {
  let clock = 1_000_000
  const recorded = {
    turns: [] as Array<{ agentId: string; text: string; initiator: string }>,
    cards: [] as Array<{ agentId: string; entryId: number; status: string }>
  }
  let server: WsRpcServer
  let view: Awaited<ReturnType<typeof fakeRfbServer>>
  let control: Awaited<ReturnType<typeof fakeRfbServer>>

  beforeAll(async () => {
    view = await fakeRfbServer(join(FAKE_DIR, 'vnc-view.sock'))
    control = await fakeRfbServer(join(FAKE_DIR, 'vnc-control.sock'))
    initScreen({
      emit: () => undefined,
      wsPort: 0,
      isBusy: (id) => id === 'busy_bot',
      enqueueTurn: (agentId, text, initiator) => { recorded.turns.push({ agentId, text, initiator }) },
      markTakeoverCard: (agentId, entryId, status) => { recorded.cards.push({ agentId, entryId, status }) },
      now: () => clock
    })
    server = await startWsServer({
      token: 'tok',
      onScreenUpgrade: (cap, req, socket, head) => handleScreenUpgrade(cap, req, socket, head)
    })
    // la porta vera per gli URL delle capability
    initScreen({
      emit: () => undefined,
      wsPort: server.port,
      isBusy: (id) => id === 'busy_bot',
      enqueueTurn: (agentId, text, initiator) => { recorded.turns.push({ agentId, text, initiator }) },
      markTakeoverCard: (agentId, entryId, status) => { recorded.cards.push({ agentId, entryId, status }) },
      now: () => clock
    })
  })

  afterAll(async () => {
    await server.close()
    await view.close()
    await control.close()
    await resetBrowserForTests()
    delete process.env.SANDBOT_TEST_FAKE_SCREEN_SOCKET
    rmSync(FAKE_DIR, { recursive: true, force: true })
  })

  beforeEach(() => {
    resetScreenForTests()
    recorded.turns.length = 0
    recorded.cards.length = 0
    dockerCalls.argvs.length = 0
  })

  it('screen:open view: URL con capability sul server ws, NESSUN x11vnc di controllo', async () => {
    const { url } = await screenOpen('agent_x', 'view')
    expect(url).toBe(`ws://127.0.0.1:${server.port}/screen/${url.split('/screen/')[1]}`)
    expect(url.startsWith(`ws://127.0.0.1:${server.port}/screen/`)).toBe(true)
    // una capability VIEW non avvia il x11vnc di controllo (nessun argv x11vnc)
    expect(dockerCalls.argvs.filter((a) => a.includes('x11vnc'))).toEqual([])
  })

  it('screen:open control su bot con turno in corso → rpcScreenBotBusy; con takeoverPending → ammesso', async () => {
    await expect(screenOpen('busy_bot', 'control')).rejects.toMatchObject({
      message: expect.stringMatching(/stop it before taking control/i),
      uiText: { id: 'rpc.screenBotBusy' }
    })
    // il take-over in attesa SBLOCCA il controllo (il bot l'ha chiesto lui)
    markTakeoverPending('busy_bot', 'login richiesto', 7)
    const { url } = await screenOpen('busy_bot', 'control')
    expect(url).toContain('/screen/')
    await expect(screenOpen('busy_bot', 'view')).resolves.toBeTruthy()
  })

  it('una capability vale UN upgrade solo; scade dopo 30 s (orologio finto)', async () => {
    const { url } = await screenOpen('agent_x', 'view')
    const cap = url.split('/screen/')[1]!
    // valido ora
    expect(consumeScreenCap(cap, clock)).toEqual({ agentId: 'agent_x', mode: 'view' })
    // RIUSO: la seconda volta non vale più (monouso)
    expect(consumeScreenCap(cap, clock)).toBeNull()
    // una capability nuova scade dopo SCREEN_CAP_TTL_MS
    const { url: url2 } = await screenOpen('agent_x', 'view')
    const cap2 = url2.split('/screen/')[1]!
    clock += SCREEN_CAP_TTL_MS + 1
    expect(consumeScreenCap(cap2, clock)).toBeNull()
  })

  it('i frame BINARI passano intatti nei DUE sensi (client → socket unix → client)', async () => {
    const { url } = await screenOpen('agent_x', 'view')
    const cap = url.split('/screen/')[1]!
    const parts: Buffer[] = []
    const sock = tcpConnect({ port: server.port, host: '127.0.0.1' }, () => {
      sock.write(upgradeWith(cap))
    })
    const closed = new Promise<void>((r) => sock.on('close', () => r()))
    // UN solo handler dati: ogni chunk finisce in parts UNA volta sola
    sock.on('data', (d: Buffer) => { parts.push(d) })

    // 101 con il subprotocollo binary (noVNC lo chiede)
    await vi.waitFor(() => expect(Buffer.concat(parts).includes('101 Switching Protocols')).toBe(true))
    expect(Buffer.concat(parts).includes('Sec-WebSocket-Protocol: binary')).toBe(true)

    // client → ponte → socket unix: il finto server RFB riceve i byte INTATTI
    const hello = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([0x01, 0x02, 0xff])])
    sock.write(maskedFrame(0x2, hello))
    await vi.waitFor(() => expect(Buffer.concat(view.received).includes(hello)).toBe(true))
    // socket unix → ponte → client: l'echo torna come frame BINARIO non mascherato
    await vi.waitFor(() => expect(firstBinaryFrame(parts)).not.toBeNull())
    expect(Buffer.compare(firstBinaryFrame(parts)!, hello)).toBe(0)

    sock.destroy()
    await closed
  })

  it('la chiusura del BROWSER chiude le connessioni dello schermo e invalida le capability', async () => {
    const { url } = await screenOpen('agent_x', 'view')
    const cap = url.split('/screen/')[1]!
    const parts: Buffer[] = []
    const sock = tcpConnect({ port: server.port, host: '127.0.0.1' }, () => sock.write(upgradeWith(cap)))
    sock.on('data', (d: Buffer) => parts.push(d))
    await vi.waitFor(() => expect(Buffer.concat(parts).includes('101 Switching Protocols')).toBe(true))
    const closed = new Promise<void>((r) => sock.on('close', () => r()))
    // il browser si chiude (idle, kill, riavvio): revoca totale
    screenBrowserClosed('agent_x')
    await closed
    // la capability non usata è invalidata
    expect(consumeScreenCap(cap, clock)).toBeNull()
  })

  it('il controllo dell\'utente è attivo con una connessione control, e il timer del browser resta sospeso', async () => {
    expect(userControlActive('agent_x')).toBe(false)
    expect(browserHoldMs('agent_x', clock)).toBeNull()
    const { url } = await screenOpen('agent_x', 'control')
    const cap = url.split('/screen/')[1]!
    const parts: Buffer[] = []
    const sock = tcpConnect({ port: server.port, host: '127.0.0.1' }, () => sock.write(upgradeWith(cap)))
    sock.on('data', (d: Buffer) => parts.push(d))
    await vi.waitFor(() => expect(Buffer.concat(parts).includes('101 Switching Protocols')).toBe(true))
    expect(userControlActive('agent_x')).toBe(true)
    // sospensione del timer: piena finché c'è la connessione, max 30 minuti
    expect(browserHoldMs('agent_x', clock)).toBe(SCREEN_HOLD_MAX_MS)
    clock += SCREEN_HOLD_MAX_MS + 1
    expect(browserHoldMs('agent_x', clock)).toBe(1) // oltre i 30 minuti si chiude comunque
    // chiusura pulita come fa noVNC: close frame mascherato (0x88) + FIN
    sock.write(maskedFrame(0x8, Buffer.from([0x03, 0xe8])))
    sock.end()
    await vi.waitFor(() => expect(userControlActive('agent_x')).toBe(false))
    expect(browserHoldMs('agent_x', clock)).toBeNull()
  })

  it('screen:release con la NOTA: il bot RIPREnde col messaggio costante e la nota delimitata', async () => {
    markTakeoverPending('agent_x', 'login su sito.example', 42)
    expect(takeoverPendingOf('agent_x')).toEqual({ reason: 'login su sito.example' })
    await screenRelease('agent_x', 'ho fatto il login e confermato il 2FA')
    expect(recorded.turns).toEqual([{
      agentId: 'agent_x',
      text: TAKEOVER_DONE_TEXT + '\n\n<nota_utente>\nho fatto il login e confermato il 2FA\n</nota_utente>',
      initiator: 'TAKEOVER_DONE'
    }])
    expect(recorded.cards).toEqual([{ agentId: 'agent_x', entryId: 42, status: 'done' }])
    expect(takeoverPendingOf('agent_x')).toBeNull()
    expect(TAKEOVER_DONE_TEXT).toBe('[The user finished on your screen.]')
  })

  it('la richiesta di presa di controllo SCADE dopo 30 minuti: card «Scaduta», niente nuovo turno', async () => {
    markTakeoverPending('agent_x', 'captcha', 10)
    tickScreen(clock + TAKEOVER_TIMEOUT_MS - 1)
    expect(takeoverPendingOf('agent_x')).not.toBeNull()
    tickScreen(clock + TAKEOVER_TIMEOUT_MS + 1)
    expect(takeoverPendingOf('agent_x')).toBeNull()
    expect(recorded.cards).toEqual([{ agentId: 'agent_x', entryId: 10, status: 'expired' }])
    expect(recorded.turns).toEqual([]) // scaduta NON riapre il turno
  })

  it('senza browser non c\'è schermo: errore UiError inglese per il modello', async () => {
    const had = process.env.SANDBOT_TEST_FAKE_BROWSER_MCP
    delete process.env.SANDBOT_TEST_FAKE_BROWSER_MCP
    try {
      await expect(screenOpen('agent_x', 'view')).rejects.toBeInstanceOf(UiError)
    } finally {
      if (had) process.env.SANDBOT_TEST_FAKE_BROWSER_MCP = had
    }
  })
})
