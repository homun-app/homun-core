// Il TERMINALE del bot (fase 19b, T2): una shell interattiva vera (PTY) nel
// box, con la STESSA identità dei comandi del bot (uid 1000, HOME e cwd nella
// home del proprietario). Solo Docker: in modalità host il terminale NON
// esiste (sarebbe una shell sul Mac, e l'utente ha già il Terminale — come
// Rakazo: «Host computers never expose a browser shell»).
//
// Il trasporto è quello della fase 19a: capability MONOUSO (32 byte
// base64url, 30 s, MAI nei log), endpoint /term/<cap> del server WebSocket
// del daemon accanto a /screen/<cap>, ponte `docker exec -i` con argv puri.
// Nessuna porta nel container. I frame BINARI del client (già incapsulati
// col protocollo di Rakazo: [kind:u8][len:u32be][payload]) vanno sullo stdin
// del processo così come sono; lo stdout del processo (i byte grezzi del pty)
// esce verso il client in frame BINARI.
//
// Non serve la presa di controllo: il terminale non tocca lo schermo né il
// browser e ha gli stessi poteri dei comandi del bot.
//
// Chiusura: la chiusura del WebSocket chiude lo stdin → il programma riceve
// EOF e manda SIGHUP alla shell; dopo 2 s di grazia il processo docker exec
// si uccide; l'uscita del processo chiude il WebSocket. Una sessione senza
// input per 30 minuti si chiude (codice 4002: il client mostra «Sessione
// chiusa per inattività»). Orfani dopo un crash del daemon: il programma
// scrive il suo pid in <home>/.sandbot/terminals/<pid>.pid e lo cancella
// all'uscita; al boot del daemon i pid rimasti si chiudono con kill -HUP
// -- -<pgid> come 1000 e i file si cancellano (lo schema degli orfani del
// browser e delle shell).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
// fase rilascio (A7): docker fuori dal PATH del Terminale
import { resolveTool, dockerChildEnv } from '../tool-paths'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { encodeFrame, decodeFrame, acceptKey, OP_CONT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG } from '../../shared/ws'
import {
  dockerTerminalArgv, dockerTermPidListArgv, dockerTermPidCleanArgv,
  dockerKillGroupArgv, CONTAINER_USER, BOX_CONTAINER
} from '../sandbox/docker-argv'
import { boxOwnerOf, sandboxMode, ensureBoxContainer, ensureBotHome, runDockerRaw } from '../sandbox'
import { UiError } from '../../shared/ui-text'
import { ui } from '../ui-language'
import { UI } from '../../shared/ui-messages'

/** La capability del terminale scade dopo 30 s se non viene usata (come lo schermo). */
export const TERM_CAP_TTL_MS = 30_000

/** Una sessione senza input per 30 minuti si chiude (T2.3). */
export const TERM_IDLE_MS = 30 * 60_000

/** Dopo la chiusura del WebSocket, il processo ha 2 s per morire da solo (poi SIGKILL). */
export const TERM_CLOSE_GRACE_MS = 2_000

/** Al massimo 3 terminali aperti per bot. */
export const TERMINALS_PER_AGENT_MAX = 3

/** Al massimo 8 terminali aperti in tutto. */
export const TERMINALS_TOTAL_MAX = 8

/** Il codice di chiusura WebSocket della sessione chiusa per inattività. */
export const TERM_IDLE_CLOSE_CODE = 4002

/** Il flag di test: al posto di docker exec gira un ponte node locale (mai in produzione). */
export function fakeTerminalEnabled(): boolean {
  return process.env.SANDBOT_TEST_FAKE_TERMINAL === '1'
}

/**
 * Il ponte FINTO dei test (mai in produzione, lo attiva SANDBOT_TEST_FAKE_TERMINAL):
 * legge i frame in ingresso col protocollo di Rakazo e risponde su stdout —
 * kind 0 → echo del payload, kind 1 → la conferma del resize — così i frame
 * si provano nei DUE sensi senza Docker né pty.
 */
export const FAKE_TERMINAL_BRIDGE_JS = [
  'let pending = Buffer.alloc(0);',
  'process.stdin.on("data", (d) => {',
  '  pending = Buffer.concat([pending, d]);',
  '  for (;;) {',
  '    if (pending.length < 5) return;',
  '    const size = pending.readUInt32BE(1);',
  '    if (pending.length < 5 + size) return;',
  '    const kind = pending[0];',
  '    const payload = pending.subarray(5, 5 + size);',
  '    pending = pending.subarray(5 + size);',
  '    if (kind === 0) process.stdout.write(payload);',
  '    else if (kind === 1 && payload.length === 4) process.stdout.write(Buffer.from(`resized ${payload.readUInt16BE(0)}x${payload.readUInt16BE(2)}\\n`));',
  '  }',
  '});',
  'process.stdin.on("end", () => process.exit(0));'
].join('\n')

// ---- lo stato (tutto in memoria, mai nei log né nel database) ----

interface TermCap {
  agentId: string
  owner: string
  expiresAt: number
  used: boolean
}
const caps = new Map<string, TermCap>()

interface TermConn {
  agentId: string
  owner: string
  /** l'ultimo frame di input ricevuto dal client (per l'inattività). */
  lastInputAt: number
  /** la socket del client (per il codice di chiusura dell'inattività). */
  socket: Duplex
  /** chiude socket e processo del ponte, idempotente. */
  destroy: () => void
}
const conns = new Set<TermConn>()

/** le dipendenze del daemon (iniettabili per i test). */
export interface TerminalDeps {
  /** orologio iniettabile (test con orologio finto); default Date.now. */
  now?: () => number
}

let now: () => number = () => Date.now()

/** Il daemon (o il test) registra l'orologio. */
export function initTerminal(d: TerminalDeps = {}): void {
  now = d.now ?? (() => Date.now())
}

/** Solo per i test: azzera lo stato in memoria. */
export function resetTerminalForTests(): void {
  caps.clear()
  for (const c of conns) c.destroy()
  conns.clear()
}

// ---- l'apertura: terminal:open (T2.3) ----

/**
 * RPC `terminal:open [agentId]` → `{ url }`. Rifiuto con UiError inglese + id
 * del catalogo se non c'è Docker o se il box non parte; tetti di 3 terminali
 * per bot e 8 in tutto («too many terminals open»). La capability è monouso,
 * scade in 30 s e NON viene mai loggata.
 */
export async function terminalOpen(agentId: string): Promise<{ url: string }> {
  if (sandboxMode() !== 'docker') {
    throw new UiError(
      'The terminal requires docker mode (Settings → Sandbox): it is not available here.',
      ui(UI.rpcTerminalUnavailable)
    )
  }
  const perAgent = [...conns].filter((c) => c.agentId === agentId).length
  if (perAgent >= TERMINALS_PER_AGENT_MAX || conns.size >= TERMINALS_TOTAL_MAX) {
    throw new UiError(
      `too many terminals open: at most ${TERMINALS_PER_AGENT_MAX} per bot and ${TERMINALS_TOTAL_MAX} in total`,
      ui(UI.rpcTerminalTooMany)
    )
  }
  const owner = boxOwnerOf(agentId)
  try {
    // la catena ensure dei comandi del bot: container, poi home (il -w dell'argv
    // non deve mai puntare a una cartella che può non esserci, regola Q1)
    await ensureBoxContainer()
    await ensureBotHome(agentId)
  } catch (e) {
    throw new UiError(
      `the box did not start, the terminal is unavailable: ${e instanceof Error ? e.message : String(e)}`,
      ui(UI.rpcTerminalBoxFailed)
    )
  }
  const cap = randomBytes(32).toString('base64url')
  caps.set(cap, { agentId, owner, expiresAt: now() + TERM_CAP_TTL_MS, used: false })
  return { url: `ws://127.0.0.1:${termWsPort()}/term/${cap}` }
}

/** La porta del server WebSocket del daemon (registrata dal wiring; 0 nei test che non la usano). */
let wsPort = 0

/** Il daemon registra la porta del server ws (per l'URL delle capability). */
export function setTerminalWsPort(port: number): void {
  wsPort = port
}

function termWsPort(): number {
  return wsPort
}

/** Consuma una capability: valida, non ancora usata e non scaduta (monouso). */
export function consumeTermCap(capId: string, at: number): { agentId: string; owner: string } | null {
  const cap = caps.get(capId)
  if (!cap) return null
  caps.delete(capId) // MONOUSO: vale un upgrade, riuso o scadenza la bruciano
  if (cap.used || at > cap.expiresAt) return null
  cap.used = true
  return { agentId: cap.agentId, owner: cap.owner }
}

// ---- l'endpoint /term/<cap>: handshake + ponte binario (T2.3) ----

/**
 * L'upgrade WebSocket del terminale: accetta SOLO una capability valida e non
 * ancora usata (la consuma), risponde col subprotocollo `binary` se il client
 * lo chiede (come lo schermo), poi avvia il ponte `docker exec -i` col
 * programma Python del PTY. I frame BINARI del client vanno sullo stdin del
 * processo COSÌ COME SONO (li incapsula già il client); lo stdout del processo
 * diventa frame BINARI verso il client.
 */
export function handleTermUpgrade(capId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const target = consumeTermCap(capId, now())
  const key = req.headers['sec-websocket-key']
  if (!target || !key) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
    return
  }
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim())
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(String(key))}\r\n` +
      (protocols.includes('binary') ? 'Sec-WebSocket-Protocol: binary\r\n' : '') +
      '\r\n'
  )

  const child = spawnTerminalBridge(target.owner)
  let closed = false
  let graceTimer: NodeJS.Timeout | null = null
  const teardown = (): void => {
    if (closed) return
    closed = true
    if (graceTimer) clearTimeout(graceTimer)
    socket.destroy()
    conns.delete(conn)
  }
  const conn: TermConn = {
    agentId: target.agentId,
    owner: target.owner,
    lastInputAt: now(),
    socket,
    destroy: () => {
      if (closed) return
      // chiusura dolce: EOF sullo stdin → il programma manda SIGHUP alla shell
      // ed esce da solo; dopo 2 s di grazia lo si uccide
      try {
        child.stdin.end()
      } catch {
        /* già chiuso */
      }
      graceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* già morto */
        }
      }, TERM_CLOSE_GRACE_MS)
      graceTimer.unref?.()
      socket.destroy()
      conns.delete(conn)
      closed = true
    }
  }
  conns.add(conn)

  // client → processo: i frame BINARI (frammentati e no) vanno sullo stdin
  // COSÌ COME SONO — l'incapsulamento [kind][len][payload] lo fa il client
  let buf: Buffer = Buffer.alloc(0)
  let frags: Buffer[] | null = null
  const deliver = (payload: Buffer): void => {
    if (!closed) {
      conn.lastInputAt = now()
      child.stdin.write(payload)
    }
  }
  socket.on('data', (d: Buffer) => {
    if (closed) return
    buf = Buffer.concat([buf, d])
    for (;;) {
      let parsed: ReturnType<typeof decodeFrame>
      try {
        parsed = decodeFrame(buf)
      } catch {
        conn.destroy()
        return
      }
      if (!parsed) return
      buf = parsed.rest
      const { opcode, payload, fin } = parsed.frame
      if (opcode === OP_PING) {
        socket.write(encodeFrame(OP_PONG, payload, false))
        continue
      }
      if (opcode === OP_PONG) continue
      if (opcode === OP_CLOSE) {
        socket.write(encodeFrame(OP_CLOSE, payload, false))
        conn.destroy()
        return
      }
      if (opcode === OP_BINARY) {
        if (fin) deliver(payload)
        else frags = [payload]
        continue
      }
      if (opcode === OP_CONT && frags) {
        frags.push(payload)
        if (fin) {
          deliver(Buffer.concat(frags))
          frags = null
        }
      }
      // i frame di testo si ignorano: il terminale parla solo binario
    }
  })
  socket.on('close', () => conn.destroy())
  socket.on('end', () => conn.destroy())
  socket.on('error', () => conn.destroy())

  // processo → client: lo stdout del pty esce in frame BINARI
  child.stdout.on('data', (d: Buffer) => {
    if (!closed) socket.write(encodeFrame(OP_BINARY, d, false))
  })
  child.stdout.on('end', teardown)
  child.stdout.on('error', teardown)
  child.on('exit', teardown)
  child.on('error', teardown)

  if (head.length > 0) socket.emit('data', head)
}

/** Chiude una connessione per inattività con il codice 4002 (il client mostra «Riapri»). */
function closeIdle(conn: TermConn): void {
  const body = Buffer.alloc(2)
  body.writeUInt16BE(TERM_IDLE_CLOSE_CODE, 0)
  // best effort: se la scrittura fallisce, la destroy di conn chiude comunque
  try {
    conn.socket.write(encodeFrame(OP_CLOSE, body, false))
  } catch {
    /* la destroy segue */
  }
  conn.destroy()
}

/** Il processo del ponte: docker exec col programma Python (o il finto dei test). */
function spawnTerminalBridge(owner: string): ChildProcessWithoutNullStreams {
  const child = fakeTerminalEnabled()
    ? spawn('node', ['-e', FAKE_TERMINAL_BRIDGE_JS], { stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(resolveTool('docker'), dockerTerminalArgv(owner), { env: dockerChildEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] })
  return child as ChildProcessWithoutNullStreams
}

// ---- il tick (inattività e scadenze): lo chiama lo scheduler ogni 30 s ----

/**
 * Le scadenze del terminale (orologio esplicito, per i test): le capability
 * scadute si buttano; una sessione senza input da TERM_IDLE_MS si chiude col
 * codice 4002.
 */
export function tickTerminal(at: number): void {
  for (const [id, cap] of caps) {
    if (at > cap.expiresAt) caps.delete(id)
  }
  for (const c of [...conns]) {
    if (at - c.lastInputAt > TERM_IDLE_MS) closeIdle(c)
  }
}

// ---- gli orfani dopo un crash del daemon (T2.3) ----

/**
 * Al boot del daemon: i pid rimasti in <home>/.sandbot/terminals/ sono i
 * terminali ORFANI di un crash — si chiudono con `kill -HUP -- -<pgid>` come
 * 1000 (il nome del file È il pgid) e i file si cancellano. Best effort:
 * senza docker o senza container non c'è nessun orfano.
 */
export async function killTerminalOrphans(agentIds: ReadonlyArray<string>): Promise<void> {
  if (sandboxMode() !== 'docker') return
  const owners = new Set(agentIds.map((id) => boxOwnerOf(id)))
  for (const owner of owners) {
    const list = await runDockerRaw(dockerTermPidListArgv(BOX_CONTAINER, owner), { timeoutMs: 15_000 }).catch(() => null)
    if (!list || list.exitCode !== 0) continue
    const pids = list.stdout
      .split('\n')
      .map((l) => /^(\d+)\.pid$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .filter((p) => Number.isInteger(p) && p > 0)
    if (!pids.length) continue
    console.log(`[terminal] ${pids.length} terminali orfani di ${owner}: chiusura`)
    for (const pgid of pids) {
      await runDockerRaw(dockerKillGroupArgv(BOX_CONTAINER, pgid, 'HUP', CONTAINER_USER), { timeoutMs: 15_000 }).catch(() => undefined)
    }
    await runDockerRaw(dockerTermPidCleanArgv(BOX_CONTAINER, owner), { timeoutMs: 15_000 }).catch(() => undefined)
  }
}

/** Quante sessioni terminale sono aperte ora (per test e diagnostica). */
export function terminalConnCount(): number {
  return conns.size
}
