// Fase 19b (T6/T9): il TERMINALE del bot — con SANDBOT_TEST_FAKE_TERMINAL=1
// il ponte gira con un programma node FINTO che parla lo STESSO protocollo
// dei frame ([kind:u8][len:u32be][payload]: 0 = echo del payload, 1 = conferma
// del resize). Si provano: la capability MONOUSO che scade (orologio finto),
// la validazione rigida di /term/ (L8: `/term/%` → 404, il server resta vivo),
// i tetti 3 per bot e 8 in tutto, i frame BINARI nei due sensi, la chiusura
// per inattività (codice 4002) e gli argv degli ORFANI al boot.
// Niente Docker: ensureBoxContainer/ensureBotHome/runDockerRaw sono finti.
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { connect as tcpConnect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { startWsServer, type WsRpcServer } from '../ws-server'

// il flag di test va impostato PRIMA dell'import: il ponte gira con node -e
process.env.SANDBOT_TEST_FAKE_TERMINAL = '1'

// la sandbox del terminale è FINTA: docker attivo, owner = l'id stesso,
// container e home sempre assicurati, runDockerRaw registra gli argv
const dockerCalls = vi.hoisted(() => ({ argvs: [] as string[][] }))
vi.mock('../../main/sandbox', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sandboxMode: () => 'docker',
  boxOwnerOf: (id: string) => id,
  ensureBoxContainer: async () => undefined,
  ensureBotHome: async () => undefined,
  runDockerRaw: async (argv: string[]) => {
    dockerCalls.argvs.push(argv)
    if (argv.includes('find') && argv.includes('-printf')) {
      return { stdout: '123.pid\n456.pid\n', stderr: '', exitCode: 0, signal: null, trimmed: false }
    }
    return { stdout: '', stderr: '', exitCode: 0, signal: null, trimmed: false }
  }
}))

import {
  initTerminal, resetTerminalForTests, terminalOpen, consumeTermCap, handleTermUpgrade,
  tickTerminal, killTerminalOrphans, terminalConnCount, setTerminalWsPort,
  TERM_CAP_TTL_MS, TERM_IDLE_MS, TERM_IDLE_CLOSE_CODE,
  TERMINALS_PER_AGENT_MAX, TERMINALS_TOTAL_MAX
} from '../../main/agent/terminal'
import { UiError } from '../../shared/ui-text'
import { dockerTerminalArgv, BOX_CONTAINER, TERMINAL_PROGRAM_PY } from '../../main/sandbox/docker-argv'

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

/** Handshake di upgrade con capability e subprotocollo binary. */
const upgradeWith = (cap: string) =>
  'GET /term/' + cap + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
  'Sec-WebSocket-Protocol: binary\r\n\r\n'

/** Un frame incapsulato del terminale ([kind][len u32be][payload]). */
function termFrame(kind: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head[0] = kind
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
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

/** Il payload del primo frame CLOSE (il codice, se c'è). */
function closeCodeOf(parts: Buffer[]): number | null {
  const b = Buffer.concat(parts)
  const hs = b.indexOf('\r\n\r\n')
  if (hs === -1) return null
  for (let i = hs + 4; i + 2 <= b.length;) {
    const fin = (b[i]! & 0x80) !== 0
    const opcode = b[i]! & 0x0f
    const masked = (b[i + 1]! & 0x80) !== 0
    const len = b[i + 1]! & 0x7f
    if (b.length < i + 2 + len) return null
    if (fin && opcode === 0x8 && len >= 2) return b.readUInt16BE(i + 2)
    i += 2 + len + (masked ? 4 : 0)
  }
  return null
}

/** Apre una sessione terminale vera sul server ws del test. */
async function openSession(port: number, agentId: string): Promise<{ sock: Socket; parts: Buffer[]; close: Promise<void> }> {
  const { url } = await terminalOpen(agentId)
  const cap = url.split('/term/')[1]!
  const parts: Buffer[] = []
  const sock = tcpConnect({ port, host: '127.0.0.1' }, () => sock.write(upgradeWith(cap)))
  sock.on('data', (d: Buffer) => parts.push(d))
  // la chiusura dal lato daemon può RESETtare: non è un errore del test
  sock.on('error', () => undefined)
  const closed = new Promise<void>((r) => sock.on('close', () => r()))
  await vi.waitFor(() => expect(Buffer.concat(parts).includes('101 Switching Protocols')).toBe(true))
  return { sock, parts, close: closed }
}

describe('fase 19b (T2/T6): il terminale del bot', () => {
  let clock = 1_000_000
  let server: WsRpcServer

  beforeAll(async () => {
    initTerminal({ now: () => clock })
    server = await startWsServer({
      token: 'tok',
      onTermUpgrade: (cap, req, socket, head) => handleTermUpgrade(cap, req, socket, head)
    })
    // la porta vera per gli URL delle capability (come fa il wiring del daemon)
    setTerminalWsPort(server.port)
  })

  afterAll(async () => {
    await server.close()
    delete process.env.SANDBOT_TEST_FAKE_TERMINAL
  })

  beforeEach(() => {
    resetTerminalForTests()
    dockerCalls.argvs.length = 0
  })

  it('terminal:open → URL ws://127.0.0.1:<porta>/term/<cap base64url>', async () => {
    const { url } = await terminalOpen('agent_x')
    expect(url.startsWith(`ws://127.0.0.1:${server.port}/term/`)).toBe(true)
    expect(url.split('/term/')[1]).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('la capability è MONOUSO e scade dopo 30 s (orologio finto)', async () => {
    const { url } = await terminalOpen('agent_x')
    const cap = url.split('/term/')[1]!
    expect(consumeTermCap(cap, clock)).toEqual({ agentId: 'agent_x', owner: 'agent_x' })
    // RIUSO: la seconda volta non vale più
    expect(consumeTermCap(cap, clock)).toBeNull()
    // una capability nuova scade dopo TERM_CAP_TTL_MS
    const { url: url2 } = await terminalOpen('agent_x')
    const cap2 = url2.split('/term/')[1]!
    clock += TERM_CAP_TTL_MS + 1
    expect(consumeTermCap(cap2, clock)).toBeNull()
  })

  it('/term/% e percorsi malformati → 404, NESSUNA eccezione, il server resta vivo (L8)', async () => {
    for (const bad of ['/term/%', '/term/%zz', '/term/a/b', `/term/${'a'.repeat(44)}`, `/term/${'='.repeat(43)}`]) {
      const parts: Buffer[] = []
      await new Promise<void>((resolve) => {
        const sock = tcpConnect({ port: server.port, host: '127.0.0.1' }, () => {
          sock.write(`GET ${bad} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`)
        })
        sock.on('data', (d: Buffer) => parts.push(d))
        sock.on('error', () => undefined)
        sock.on('close', () => resolve())
      })
      expect(Buffer.concat(parts).includes('404 Not Found'), bad).toBe(true)
    }
    // il server risponde ancora a una capability ben formata
    const { url } = await terminalOpen('agent_x')
    expect(url).toContain('/term/')
  })

  it('i frame BINARI passano intatti nei DUE sensi (input → echo, resize → conferma)', async () => {
    const session = await openSession(server.port, 'agent_x')
    try {
      // input (kind 0): il finto ponte risponde lo STESSO payload
      const hello = Buffer.from('echo da provare \xc3\xa0')
      session.sock.write(maskedFrame(0x2, termFrame(0, hello)))
      await vi.waitFor(() => expect(firstBinaryFrame(session.parts)).not.toBeNull())
      expect(Buffer.compare(firstBinaryFrame(session.parts)!, hello)).toBe(0)
      // resize (kind 1, cols:u16be rows:u16be): il finto ponte conferma — il
      // payload del frame arriva VERBATIM nel flusso non mascherato
      session.sock.write(maskedFrame(0x2, termFrame(1, Buffer.from([0, 120, 0, 40]))))
      await vi.waitFor(() => expect(Buffer.concat(session.parts).includes(Buffer.from('resized 120x40\n'))).toBe(true))
    } finally {
      session.sock.destroy()
      await session.close
    }
  })

  it('tetti: al massimo 3 terminali per bot e 8 in TUTTO («too many terminals open»)', async () => {
    // 3 sessioni per agent_x: la quarta si rifiuta
    const sessions: Array<{ sock: Socket; close: Promise<void> }> = []
    for (let i = 0; i < TERMINALS_PER_AGENT_MAX; i++) sessions.push(await openSession(server.port, 'agent_x'))
    await expect(terminalOpen('agent_x')).rejects.toMatchObject({
      message: expect.stringMatching(/too many terminals open/i)
    })
    expect(terminalConnCount()).toBe(TERMINALS_PER_AGENT_MAX)
    // fino a 8 IN TUTTO: altre 3 per agent_y e 2 per agent_z
    for (let i = 0; i < 3; i++) sessions.push(await openSession(server.port, 'agent_y'))
    for (let i = 0; i < 2; i++) sessions.push(await openSession(server.port, 'agent_z'))
    expect(terminalConnCount()).toBe(TERMINALS_TOTAL_MAX)
    await expect(terminalOpen('agent_w')).rejects.toBeInstanceOf(UiError)
    // chiudendo una sessione torna posto (la connessione si stacca quando il
    // ponte esce, entro la grazia dei 2 s)
    sessions[0]!.sock.destroy()
    await sessions[0]!.close
    await vi.waitFor(() => expect(terminalConnCount()).toBe(TERMINALS_TOTAL_MAX - 1))
    await expect(terminalOpen('agent_x')).resolves.toMatchObject({ url: expect.stringContaining('/term/') })
  })

  it('la chiusura del WebSocket chiude la sessione (EOF → il ponte esce)', async () => {
    const session = await openSession(server.port, 'agent_x')
    // close handshake come fa il client vero
    session.sock.write(maskedFrame(0x8, Buffer.from([0x03, 0xe8])))
    session.sock.end()
    await session.close
    await vi.waitFor(() => expect(terminalConnCount()).toBe(0))
  })

  it('una sessione senza input per 30 minuti si chiude col codice 4002', async () => {
    const session = await openSession(server.port, 'agent_x')
    expect(terminalConnCount()).toBe(1)
    // un input RITARDA la scadenza
    clock += TERM_IDLE_MS - 1_000
    session.sock.write(maskedFrame(0x2, termFrame(0, Buffer.from('x'))))
    tickTerminal(clock)
    expect(terminalConnCount()).toBe(1)
    // dopo 30 minuti dall'ULTIMO input: chiusura 4002 (il client mostra «Riapri»)
    clock += TERM_IDLE_MS + 1
    tickTerminal(clock)
    await session.close
    expect(closeCodeOf(session.parts)).toBe(TERM_IDLE_CLOSE_CODE)
    expect(terminalConnCount()).toBe(0)
  })

  it('gli ORFANI al boot: kill -HUP del gruppo come 1000 e pulizia dei pid file', async () => {
    await killTerminalOrphans(['agent_x'])
    const flat = dockerCalls.argvs.map((a) => a.join(' '))
    // l'elenco dei pid file
    expect(flat.some((s) => s.includes(`exec -i -u 1000:1000 -w /box sandbot-box find /box/home/agent_x/.sandbot/terminals -maxdepth 1 -name *.pid -printf %f\\n`) || (s.includes('terminals') && s.includes('-printf')))).toBe(true)
    // kill -HUP -- -<pgid> per OGNI pid trovato (123 e 456)
    expect(dockerCalls.argvs).toContainEqual(['exec', '-u', '1000:1000', BOX_CONTAINER, 'kill', '-HUP', '--', '-123'])
    expect(dockerCalls.argvs).toContainEqual(['exec', '-u', '1000:1000', BOX_CONTAINER, 'kill', '-HUP', '--', '-456'])
    // e i file si cancellano
    expect(flat.some((s) => s.includes('-delete'))).toBe(true)
  })

  it('senza docker NESSUN terminale: UiError col testo inglese e l\'id del catalogo (T6)', async () => {
    // sandboxMode finta → per questo test si ripristina l'originale via modulo
    const sandbox = await import('../../main/sandbox')
    const original = (sandbox as unknown as { sandboxMode: () => string }).sandboxMode
    ;(sandbox as unknown as { sandboxMode: () => string }).sandboxMode = () => 'host'
    try {
      await expect(terminalOpen('agent_x')).rejects.toMatchObject({
        message: expect.stringMatching(/requires docker mode/i),
        uiText: { id: 'rpc.terminalUnavailable' }
      })
    } finally {
      ;(sandbox as unknown as { sandboxMode: () => string }).sandboxMode = original
    }
  })

  it('l\'argv del terminale (T6): -u 1000:1000, -w e HOME sulla home, NESSUN segreto, python3 -c col programma COSTANTE', () => {
    const argv = dockerTerminalArgv('agent_x')
    expect(argv).toEqual([
      'exec', '-i',
      '-u', '1000:1000',
      '-w', '/box/home/agent_x',
      '-e', 'HOME=/box/home/agent_x',
      '-e', 'TERM=xterm-256color',
      BOX_CONTAINER,
      'python3', '-c', TERMINAL_PROGRAM_PY,
      '/box/home/agent_x'
    ])
    expect(argv.filter((a) => a.startsWith('SANDBOT_SECRET_'))).toEqual([])
    expect(argv).not.toContain('sh')
    // il programma: pty.fork, shell di login bash -l, frame in ingresso,
    // resize TIOCSWINSZ limitato 1–1000, tetto 1 MiB, SIGHUP al gruppo, pid file
    expect(TERMINAL_PROGRAM_PY).toContain('pty.fork()')
    expect(TERMINAL_PROGRAM_PY).toContain('os.execvpe("/bin/bash", ["bash", "-l"], env)')
    expect(TERMINAL_PROGRAM_PY).toContain('TERM="xterm-256color"')
    expect(TERMINAL_PROGRAM_PY).toContain('struct.unpack(">I"')
    expect(TERMINAL_PROGRAM_PY).toContain('TIOCSWINSZ')
    expect(TERMINAL_PROGRAM_PY).toContain('min(1000, max(1, cols))')
    expect(TERMINAL_PROGRAM_PY).toContain('MAX_FRAME')
    expect(TERMINAL_PROGRAM_PY).toContain('os.killpg(pid, signal.SIGHUP)')
    expect(TERMINAL_PROGRAM_PY).toContain('.sandbot", "terminals")')
    // l'uscita del pty va su stdout come BYTE GREZZI (write_all su fd 1, che
    // è os.write), MAI print
    expect(TERMINAL_PROGRAM_PY).toContain('write_all(1, data)')
    expect(TERMINAL_PROGRAM_PY).toContain('data[os.write(fd, data):]')
    expect(TERMINAL_PROGRAM_PY).not.toContain('print(')
  })
})
