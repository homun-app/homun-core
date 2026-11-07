// Lo SCHERMO del bot (fase 19a, V3): il desktop del browser principale nel
// box, la vista dal vivo in Homun e la presa di controllo dell'utente. Tutto
// vive in MEMORIA nel daemon (capability monouso, connessioni, richieste di
// presa di controllo): niente segreti nei log, niente stato nel database.
//
// Sicurezza (le decisioni che contano):
// - NESSUN listener di rete nel container: x11vnc ascolta SOLO su socket unix
//   dentro /browser/<owner>/ (0700 di 1001) e il daemon ci arriva con
//   `docker exec -u 1001` — la shell del bot (uid 1000, stesso namespace di
//   rete) non può vedere né comandare lo schermo del browser;
// - la capability è MONOUSO (32 byte casuali base64url), legata a bot e modo,
//   scade dopo 30 s se non usata e non viene mai loggata;
// - `control` è ammesso solo se il bot NON ha un turno in corso (o se c'è una
//   SUA richiesta di presa di controllo in attesa): rpcScreenBotBusy altrimenti.
//
// Il ponte verso la UI è l'endpoint /screen/<cap> del server WebSocket del
// daemon: i frame BINARI WebSocket passano intatti allo stdio di
// `docker exec -i -u 1001:1001 <box> node -e <PONTE> <socket>` (argv puri,
// nessuna shell). Il flag di test SANDBOT_TEST_FAKE_SCREEN_SOCKET=<dir>
// sostituisce docker exec con un socket unix locale del test (come
// SANDBOT_TEST_FAKE_BROWSER_MCP, non esiste in produzione).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
// fase rilascio (A7): docker fuori dal PATH del Terminale
import { resolveTool, dockerChildEnv } from '../tool-paths'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import {
  encodeFrame, decodeFrame, acceptKey, OP_CONT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG
} from '../../shared/ws'
import {
  browserViewSocket, browserControlSocket,
  dockerScreenBridgeArgv, dockerScreenControlVncArgv, dockerScreenControlPidReadArgv,
  dockerScreenSocketReadyArgv, dockerScreenDisplayReadArgv, SCREEN_BRIDGE_NODE_JS,
  dockerKillGroupArgv, BROWSER_USER, BOX_CONTAINER
} from '../sandbox/docker-argv'
import { boxOwnerOf, runDockerRaw } from '../sandbox'
import { UiError } from '../../shared/ui-text'
import { ui } from '../ui-language'
import { UI } from '../../shared/ui-messages'
import type { SandbotEvent, ScreenStatus } from '../../shared/types'

/** La capability scade dopo 30 s se non viene usata (V3.1). */
export const SCREEN_CAP_TTL_MS = 30_000

/** La richiesta di presa di controllo scade dopo 30 minuti (V5, come Rakazo). */
export const TAKEOVER_TIMEOUT_MS = 30 * 60_000

/** La sospensione del timer di inattività dura al massimo 30 minuti (V2). */
export const SCREEN_HOLD_MAX_MS = 30 * 60_000

/** Il messaggio costante (inglese) che riapre il turno del bot dopo il controllo (V5). */
export const TAKEOVER_DONE_TEXT = '[The user finished on your screen.]'

/** Il flag di test: il ponte si collega a un socket unix locale invece di docker exec. */
export function fakeScreenSocketDir(): string | null {
  return process.env.SANDBOT_TEST_FAKE_SCREEN_SOCKET ?? null
}

// ---- le dipendenze del daemon (iniettabili per i test) ----

export interface ScreenDeps {
  /** evento push alla UI (il broadcast del daemon). */
  emit: (e: SandbotEvent) => void
  /** la porta del server WebSocket del daemon (l'URL della capability). */
  wsPort: number
  /** il bot ha un turno in corso? (loop.isRunning) */
  isBusy: (agentId: string) => boolean
  /** riapre il turno del bot dopo la presa di controllo (testo inglese costante). */
  enqueueTurn: (agentId: string, text: string, initiator: string, extraMeta?: Record<string, unknown>) => void
  /** aggiorna la card della richiesta di presa di controllo (pending → done/expired). */
  markTakeoverCard: (agentId: string, entryId: number, status: 'done' | 'expired') => void
  /** orologio iniettabile (test con orologio finto); default Date.now. */
  now?: () => number
}

/** le dipendenze attive (now SEMPRE presente: il default è Date.now). */
let deps: ScreenDeps & { now: () => number } = {
  emit: () => undefined,
  wsPort: 0,
  isBusy: () => false,
  enqueueTurn: () => undefined,
  markTakeoverCard: () => undefined,
  now: () => Date.now()
}

/** Il daemon registra qui le sue dipendenze (V3). */
export function initScreen(d: ScreenDeps): void {
  deps = { ...d, now: d.now ?? (() => Date.now()) }
}

/** Solo per i test: azzera lo stato in memoria. */
export function resetScreenForTests(): void {
  caps.clear()
  for (const c of conns) c.destroy()
  conns.clear()
  controlVncOwners.clear()
  takeovers.clear()
  holdSince.clear()
}

// ---- lo stato (tutto in memoria, mai nei log né nel database) ----

interface ScreenCap {
  agentId: string
  mode: 'view' | 'control'
  expiresAt: number
  used: boolean
}
const caps = new Map<string, ScreenCap>()

interface ScreenConn {
  agentId: string
  mode: 'view' | 'control'
  /** chiude socket e processo del ponte, idempotente. */
  destroy: () => void
}
const conns = new Set<ScreenConn>()

/** i proprietari col x11vnc di controllo attivo (avviato SOLO durante il controllo). */
const controlVncOwners = new Set<string>()

/** le richieste di presa di controllo in attesa (V5): bot → motivo, card, scadenza. */
const takeovers = new Map<string, { reason: string; entryId: number; expiresAt: number }>()

/** da quando il timer di inattività del browser è sospeso per quel bot (V2). */
const holdSince = new Map<string, number>()

// ---- lo stato che la UI legge (screen:status + evento screen) ----

/** La vista dello schermo di un bot per la UI (V3.4). */
export async function screenStatus(agentId: string): Promise<ScreenStatus> {
  const browser = await import('./browser')
  const pending = takeovers.get(agentId)
  return {
    browser: browser.isBrowserRunning(agentId) ? 'running' : 'stopped',
    control: [...conns].some((c) => c.agentId === agentId && c.mode === 'control'),
    takeoverPending: pending ? { reason: pending.reason } : null,
    // fase pagine (G3): lo schermo è in uso (vista o controllo aperti o
    // richiesta in attesa) — il timer di inattività è SOSPESO
    held: browserHoldMs(agentId, Date.now()) !== null
  }
}

/** Emette l'evento `screen` di un bot (a ogni cambio di stato, V3.4). */
async function emitStatus(agentId: string): Promise<void> {
  deps.emit({ type: 'screen', agentId, status: await screenStatus(agentId) })
}

// ---- il timer di inattività del browser, sospeso mentre lo schermo è in uso (V2) ----

/**
 * Quanto tempo ancora il browser di quel bot deve restare vivo OLTRE il timer
 * di inattività: null = nessuna sospensione (si chiude pure). La sospensione
 * vale mentre c'è una vista o un controllo aperto o una richiesta di presa di
 * controllo in attesa, e dura AL MASSIMO 30 minuti dal primo istante.
 */
export function browserHoldMs(agentId: string, now: number): number | null {
  const held =
    [...conns].some((c) => c.agentId === agentId) || takeovers.has(agentId)
  if (!held) {
    holdSince.delete(agentId)
    return null
  }
  if (!holdSince.has(agentId)) holdSince.set(agentId, now)
  return Math.max(SCREEN_HOLD_MAX_MS - (now - holdSince.get(agentId)!), 1)
}

// ---- l'apertura: screen:open (V3.1) ----

/**
 * RPC `screen:open [agentId, mode]`: avvia il browser del bot se non c'è (lazy,
 * about:blank), aspetta il socket della vista e — per `control` — avvia il
 * secondo x11vnc senza -viewonly. Torna l'URL WebSocket con una capability
 * MONOUSO che scade dopo 30 s. `control` su bot con turno in corso (senza una
 * sua richiesta in attesa) → UiError rpcScreenBotBusy.
 */
export async function screenOpen(agentId: string, mode: 'view' | 'control'): Promise<{ url: string }> {
  const browser = await import('./browser')
  if (!browser.browserAvailable()) {
    throw new UiError(browser.BROWSER_UNAVAILABLE, ui(UI.rpcScreenUnavailable))
  }
  if (mode === 'control' && deps.isBusy(agentId) && !takeovers.has(agentId)) {
    throw new UiError('The bot is working: stop it before taking control.', ui(UI.rpcScreenBotBusy))
  }
  await browser.ensureBrowserForScreen(agentId)
  await waitForSocket(browserViewSocket(boxOwnerOf(agentId)))
  if (mode === 'control') await ensureControlVnc(agentId)
  const cap = randomBytes(32).toString('base64url')
  caps.set(cap, { agentId, mode, expiresAt: deps.now() + SCREEN_CAP_TTL_MS, used: false })
  void emitStatus(agentId)
  return { url: `ws://127.0.0.1:${deps.wsPort}/screen/${cap}` }
}

/** Consuma una capability: valida, non ancora usata e non scaduta (V3.2). */
export function consumeScreenCap(capId: string, now: number): { agentId: string; mode: 'view' | 'control' } | null {
  const cap = caps.get(capId)
  if (!cap) return null
  caps.delete(capId) // MONOUSO: vale un upgrade, riuso o scadenza la bruciano
  if (cap.used || now > cap.expiresAt) return null
  cap.used = true
  return { agentId: cap.agentId, mode: cap.mode }
}

// ---- i socket del desktop: attesa e x11vnc di controllo (V3.1) ----

/** Aspetta che un socket unix del desktop esista (al massimo 15 s, polling). */
async function waitForSocket(socketPath: string): Promise<void> {
  const fake = fakeScreenSocketDir()
  const deadline = deps.now() + 15_000
  for (;;) {
    const ok = fake
      ? existsSync(join(fake, basename(socketPath)))
      : (await runDockerRaw(dockerScreenSocketReadyArgv(BOX_CONTAINER, socketPath), { timeoutMs: 10_000 })).exitCode === 0
    if (ok) return
    if (deps.now() >= deadline) {
      throw new UiError(
        `the screen of the bot is not ready (socket ${basename(socketPath)} not there)`,
        ui(UI.rpcScreenNotReady)
      )
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** Il numero di display scelto da -displayfd (file display del wrapper), senza due punti. */
async function readDisplay(owner: string): Promise<string> {
  const r = await runDockerRaw(dockerScreenDisplayReadArgv(BOX_CONTAINER, owner), { timeoutMs: 10_000 })
  const n = r.exitCode === 0 ? r.stdout.trim() : ''
  if (!/^\d+$/.test(n)) {
    throw new UiError('the bot has no screen open', ui(UI.rpcScreenNotOpen))
  }
  return n
}

/**
 * Il secondo x11vnc, quello di CONTROLLO (V3.1): avviato SOLO durante la presa
 * di controllo, senza -viewonly, sullo stesso socket unix della vista (nome
 * diverso). Il pid va nel file vnc-control.pid per il kill di gruppo a fine
 * controllo. In modalità test il socket lo prepara il test.
 */
async function ensureControlVnc(agentId: string): Promise<void> {
  const owner = boxOwnerOf(agentId)
  if (controlVncOwners.has(owner)) {
    await waitForSocket(browserControlSocket(owner))
    return
  }
  if (!fakeScreenSocketDir()) {
    const display = await readDisplay(owner)
    const start = await runDockerRaw(dockerScreenControlVncArgv(owner, display), { timeoutMs: 15_000 })
    if (start.exitCode !== 0) {
      throw new UiError(`the control screen failed to start: ${start.stderr || `exit ${start.exitCode}`}`, ui(UI.rpcScreenControlFailed))
    }
  }
  controlVncOwners.add(owner)
  await waitForSocket(browserControlSocket(owner))
}

/** Uccide il x11vnc di controllo di un proprietario (kill di gruppo dal pid file). */
async function stopControlVnc(agentId: string): Promise<void> {
  const owner = boxOwnerOf(agentId)
  controlVncOwners.delete(owner)
  if (fakeScreenSocketDir()) return
  const pid = await runDockerRaw(dockerScreenControlPidReadArgv(BOX_CONTAINER, owner), { timeoutMs: 10_000 }).catch(() => null)
  const pgid = pid && pid.exitCode === 0 ? Number(pid.stdout.trim()) : NaN
  if (Number.isInteger(pgid) && pgid > 0) {
    await runDockerRaw(dockerKillGroupArgv(BOX_CONTAINER, pgid, 'TERM', BROWSER_USER), { timeoutMs: 15_000 }).catch(() => undefined)
  }
}

// ---- l'endpoint /screen/<cap>: handshake + ponte binario (V3.2) ----

/**
 * L'upgrade WebSocket dello schermo: accetta SOLO una capability valida e non
 * ancora usata (la consuma), risponde col subprotocollo `binary` se il client
 * lo chiede (noVNC lo chiede), poi collega il socket unix dello schermo allo
 * stdio del ponte. I frame BINARI WebSocket passano intatti nei due sensi;
 * la chiusura da uno dei due lati chiude l'altro e il processo muore SEMPRE.
 */
export function handleScreenUpgrade(capId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const target = consumeScreenCap(capId, deps.now())
  const key = req.headers['sec-websocket-key']
  if (!target || !key) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
    return
  }
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',').map((p) => p.trim())
  const res =
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(String(key))}\r\n` +
    (protocols.includes('binary') ? 'Sec-WebSocket-Protocol: binary\r\n' : '') +
    '\r\n'
  socket.write(res)

  const socketPath = target.mode === 'control'
    ? browserControlSocket(boxOwnerOf(target.agentId))
    : browserViewSocket(boxOwnerOf(target.agentId))
  const child = spawnBridge(socketPath)
  let closed = false
  const teardown = (): void => {
    if (closed) return
    closed = true
    socket.destroy()
    child.kill('SIGKILL') // il processo del ponte si uccide SEMPRE
    conns.delete(conn)
    void afterClose(target)
  }
  const conn: ScreenConn = { agentId: target.agentId, mode: target.mode, destroy: teardown }
  conns.add(conn)

  // client → socket unix: i frame BINARI (frammentati e no) vanno allo stdin
  let buf: Buffer = Buffer.alloc(0)
  let frags: Buffer[] | null = null
  const deliver = (payload: Buffer): void => {
    if (!closed) child.stdin.write(payload)
  }
  socket.on('data', (d: Buffer) => {
    if (closed) return
    buf = Buffer.concat([buf, d])
    for (;;) {
      let parsed: ReturnType<typeof decodeFrame>
      try {
        parsed = decodeFrame(buf)
      } catch {
        teardown()
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
        teardown()
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
      // i frame di testo si ignorano: il ponte parla solo binario
    }
  })
  // la chiusura da uno dei due lati chiude l'altro: close (reset), end (FIN
  // senza handshake WebSocket) ed exit/error del processo del ponte
  socket.on('close', teardown)
  socket.on('end', teardown)
  socket.on('error', teardown)

  // socket unix → client: lo stdout del ponte esce in frame BINARI
  child.stdout.on('data', (d: Buffer) => {
    if (!closed) socket.write(encodeFrame(OP_BINARY, d, false))
  })
  child.stdout.on('end', teardown)
  child.stdout.on('error', teardown)
  child.on('exit', teardown)
  child.on('error', teardown)

  if (head.length > 0) socket.emit('data', head)
}

/** Dopo la chiusura di una connessione: l'ultimo controllo spegne il suo x11vnc. */
async function afterClose(target: { agentId: string; mode: 'view' | 'control' }): Promise<void> {
  if (target.mode === 'control' && ![...conns].some((c) => c.agentId === target.agentId && c.mode === 'control')) {
    await stopControlVnc(target.agentId).catch(() => undefined)
  }
  void emitStatus(target.agentId)
}

/** Il processo del ponte: docker exec (o il socket locale del flag di test). */
function spawnBridge(socketPath: string): ChildProcessWithoutNullStreams {
  const fake = fakeScreenSocketDir()
  const child = fake
    ? spawn('node', ['-e', SCREEN_BRIDGE_NODE_JS, join(fake, basename(socketPath))], { stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(resolveTool('docker'), dockerScreenBridgeArgv(socketPath), { env: dockerChildEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] })
  return child as ChildProcessWithoutNullStreams
}

// ---- la chiusura e la revoca (V3.3 + revoca) ----

/**
 * RPC `screen:release [agentId, note?]` (V3.3): chiude tutte le connessioni
 * CONTROLLO del bot e uccide il x11vnc di controllo (le viste restano aperte).
 * Se c'era una richiesta di presa di controllo in attesa, la card passa a
 * «Fatto» e il bot RIPREnde con il messaggio costante più l'eventuale nota
 * dell'utente, delimitata come testo dell'utente.
 */
export async function screenRelease(agentId: string, note?: string): Promise<{ ok: true }> {
  for (const c of [...conns]) {
    if (c.agentId === agentId && c.mode === 'control') c.destroy()
  }
  await stopControlVnc(agentId).catch(() => undefined)
  const pending = takeovers.get(agentId)
  if (pending) {
    takeovers.delete(agentId)
    deps.markTakeoverCard(agentId, pending.entryId, 'done')
    const clean = typeof note === 'string' ? note.trim().slice(0, 2000) : ''
    deps.enqueueTurn(
      agentId,
      TAKEOVER_DONE_TEXT + (clean ? `\n\n<nota_utente>\n${clean}\n</nota_utente>` : ''),
      'TAKEOVER_DONE',
      { ui: ui(UI.takeoverDoneLine) }
    )
  }
  void emitStatus(agentId)
  return { ok: true }
}

/**
 * Revoca totale quando il browser del bot si chiude (inattività, kill, riavvio
 * del daemon): tutte le connessioni dello schermo di quel bot si chiudono, le
 * capability non usate si invalidano e il x11vnc di controllo muore. Chiamata
 * da browser.ts a OGNI chiusura della sessione (idempotente).
 */
export function screenBrowserClosed(agentId: string): void {
  const owner = boxOwnerOf(agentId)
  for (const cap of caps) {
    if (cap[1].agentId === agentId) caps.delete(cap[0])
  }
  for (const c of [...conns]) {
    if (c.agentId === agentId) c.destroy()
  }
  void stopControlVnc(agentId).catch(() => undefined)
  void emitStatus(agentId)
}

// ---- la presa di controllo chiesta dal bot (V5) ----

/**
 * Il bot ha chiamato request_takeover: la richiesta è SEGNAta (takeoverPending)
 * per 30 minuti — la card in chat e la vista dal vivo la mostrano, il timer di
 * inattività del browser resta sospeso finché resta in attesa.
 */
export function markTakeoverPending(agentId: string, reason: string, entryId: number): void {
  takeovers.set(agentId, { reason, entryId, expiresAt: deps.now() + TAKEOVER_TIMEOUT_MS })
  void emitStatus(agentId)
}

/** La richiesta di presa di controllo in attesa di un bot (null se non c'è). */
export function takeoverPendingOf(agentId: string): { reason: string } | null {
  const t = takeovers.get(agentId)
  return t ? { reason: t.reason } : null
}

/** Il controllo dell'utente è attivo sullo schermo di quel bot? (V6: computer_act si rifiuta). */
export function userControlActive(agentId: string): boolean {
  return [...conns].some((c) => c.agentId === agentId && c.mode === 'control')
}

// ---- il tick (scadenze): lo chiama lo scheduler del daemon ogni 30 s ----

/**
 * Le scadenze dello schermo (orologio esplicito, per i test): le capability
 * scadute si buttano; una richiesta di presa di controllo non aperta entro 30
 * minuti scade — la card passa a «Scaduta» e il browser torna al timer normale.
 */
export function tickScreen(now: number): void {
  for (const [id, cap] of caps) {
    if (now > cap.expiresAt) caps.delete(id)
  }
  for (const [agentId, t] of takeovers) {
    if (now > t.expiresAt) {
      takeovers.delete(agentId)
      deps.markTakeoverCard(agentId, t.entryId, 'expired')
      void emitStatus(agentId)
    }
  }
}
