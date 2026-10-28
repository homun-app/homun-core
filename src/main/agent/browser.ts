// Il BROWSER del bot (fase 11b, punto 2): Playwright MCP nel container, UNA
// istanza per bot, AVVIO LAZY alla prima azione. Il trasporto è StdioClient-
// Transport con command 'docker' e argv PURI (wrapper COSTANTE che scrive il
// pid nella home del bot + flag obbligatori del server). Lo snapshot
// (albero di accessibilità con i ref) è ciò che il modello legge: costa pochi
// token e funziona anche senza visione. Il loop intercetta le chiamate e ci
// mette il confine: classificazione del rischio (browser-guard), blocco
// evidenza, contaminazione del turno, troncamento.
//
// Ciclo di vita: chiusura dopo 10 minuti senza azioni (nostri + --idle-timeout
// del server), al massimo 3 browser per box, kill dell'orfano dal pid file al
// boot e prima di ogni avvio (se il daemon muore, il processo nel container
// non muore da solo). SOLO in docker con rete bridge: mai un browser sul Mac
// dell'utente; il flag di test SANDBOT_TEST_FAKE_BROWSER_MCP=<path> sostituisce
// `docker exec …` con `node <path>` (verifica d'integrazione, non esiste in
// produzione).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolDef } from './llm'
import { checkUrl } from './web-guard'
import {
  refInfo, truncateSnapshot, snapshotChallenge, browserPageUrl,
  SNAPSHOT_BLOCKED_NOTE, type RefInfo
} from './browser-guard'
import {
  dockerBrowserMcpArgv, browserMcpFlags, BOX_CONTAINER, BROWSER_PID_FILE,
  BROWSER_IDLE_MS, BROWSERS_PER_BOX_MAX, boxHomePath, dockerReadFileArgv, dockerKillGroupArgv
} from '../sandbox/docker-argv'
import {
  sandboxMode, browserSandboxOk, ensureBoxContainer, ensureBotHome, runDockerRaw
} from '../sandbox'
import { ensureBrowserProxy } from './browser-proxy'
import { parseShellPgid } from './shells'
import { randomUUID } from 'node:crypto'

/** Il browser è disponibile? (docker + rete bridge; il flag di test attiva il percorso in host). */
export function browserAvailable(): boolean {
  if (process.env.SANDBOT_TEST_FAKE_BROWSER_MCP) return true
  return browserSandboxOk()
}

/** Il result quando il browser non c'è (mai un browser sul Mac dell'utente). */
export const BROWSER_UNAVAILABLE =
  'Il browser richiede la modalità docker (Impostazioni → Sandbox): qui non è disponibile. Di\' all\'utente che può attivarla da lì.'

/** L'attesa massima di browser_wait (secondi). */
export const BROWSER_WAIT_MAX_SEC = 30

/** I tool del browser (punto 2): nomi SandBot, dietro c'è la chiamata MCP. */
export const browserToolDefs: ToolDef[] = [
  {
    name: 'browser_open',
    description: 'Apre un URL nel browser del bot (solo http/https) e restituisce lo snapshot della pagina. È il gradino dopo web_search/web_fetch: per i siti costruiti in JavaScript, i moduli e le pagine che web_fetch non riesce a leggere.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL http/https della pagina' } },
      required: ['url']
    }
  },
  {
    name: 'browser_snapshot',
    description: 'Ristampa lo snapshot della pagina corrente (albero di accessibilità con i ref). Con ref o depth restringe a un elemento o a una profondità: lo snapshot lungo si restringe così.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Ref dell\'elemento da cui partire (opzionale)' },
        depth: { type: 'number', description: 'Profondità massima dell\'albero (opzionale)' }
      },
      required: []
    }
  },
  {
    name: 'browser_click',
    description: 'Clicca l\'elemento col SUO ref preso dallo snapshot (mai a coordinate). I click che inviano, comprano o prenotano chiedono prima la conferma dell\'utente.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Ref dell\'elemento dallo snapshot' } },
      required: ['ref']
    }
  },
  {
    name: 'browser_type',
    description: 'Scrive testo nel campo col suo ref (submit: true preme anche Invio e invia il modulo). Non scrive MAI password o dati di carta: quei passaggi li fa l\'utente.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Ref del campo dallo snapshot' },
        text: { type: 'string', description: 'Testo da scrivere' },
        submit: { type: 'boolean', description: 'True per inviare anche il modulo (chiede conferma)' }
      },
      required: ['ref', 'text']
    }
  },
  {
    name: 'browser_select',
    description: 'Sceglie i valori di un menu a tendina col suo ref.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Ref del menu dallo snapshot' },
        values: { type: 'array', items: { type: 'string' }, description: 'Valori da selezionare' }
      },
      required: ['ref', 'values']
    }
  },
  {
    name: 'browser_press_key',
    description: 'Preme un tasto sulla pagina (es. "Enter", "Tab", "Escape").',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Tasto o combo (es. Enter, Control+a)' } },
      required: ['key']
    }
  },
  {
    name: 'browser_back',
    description: 'Torna alla pagina precedente.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'browser_wait',
    description: 'Attende sulla pagina corrente (al massimo 30 s): finché compare un testo, o i secondi indicati.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Testo da aspettare (opzionale)' },
        seconds: { type: 'number', description: 'Secondi di attesa (opzionale, massimo 30)' }
      },
      required: []
    }
  },
  {
    name: 'browser_tabs',
    description: 'Gestisce le schede del browser: action new|select|close, con index o url.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['new', 'select', 'close'], description: 'Azione sulla scheda' },
        index: { type: 'number', description: 'Indice della scheda (per select/close)' },
        url: { type: 'string', description: 'URL della nuova scheda (per new)' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser_screenshot',
    description: 'Scatta uno screenshot della pagina e lo salva nel box: il result dà il path del file png.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'browser_close',
    description: 'Chiude la pagina corrente del browser.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
]

// ---- lo stato per bot: client MCP, ultimo snapshot, ultima URL, timer di inattività ----

interface BrowserSession {
  client: Client
  /** ultimo snapshot ricevuto (grezzo, capato): è la verità per i ref */
  snapshot: string
  /** ultima URL della pagina (dal result MCP o dall'apertura) */
  url: string
  lastActionAt: number
  closeTimer: NodeJS.Timeout
}

const sessions = new Map<string, BrowserSession>()

/** L'ultimo snapshot ricevuto per un bot (null se mai aperto): è da qui che i ref si verificano. */
export function lastSnapshotOf(agentId: string): string | null {
  return sessions.get(agentId)?.snapshot ?? null
}

/** L'ultima URL nota della pagina di un bot (per la card delle azioni). */
export function lastUrlOf(agentId: string): string | null {
  return sessions.get(agentId)?.url ?? null
}

/** Il ruolo+nome di un ref nell'ultimo snapshot del bot (puro via browser-guard). */
export function refInfoOf(agentId: string, ref: string): RefInfo | null {
  return refInfo(lastSnapshotOf(agentId), ref)
}

/** Solo per i test: azzera le sessioni (chiudendo i client). */
export async function resetBrowserForTests(): Promise<void> {
  for (const [id, s] of sessions) {
    clearTimeout(s.closeTimer)
    await s.client.close().catch(() => undefined)
    sessions.delete(id)
  }
}

/** Chiude l'istanza browser di un bot (idle, fine turno del daemon, test). */
export async function closeBrowser(agentId: string): Promise<void> {
  const s = sessions.get(agentId)
  if (!s) return
  clearTimeout(s.closeTimer)
  sessions.delete(agentId)
  await s.client.close().catch(() => undefined)
}

function touchSession(agentId: string, s: BrowserSession): void {
  s.lastActionAt = Date.now()
  clearTimeout(s.closeTimer)
  // chiusura dopo 10 minuti senza azioni, lato nostro (il server ha pure
  // --idle-timeout: due sveglie indipendenti)
  s.closeTimer = setTimeout(() => {
    void closeBrowser(agentId).catch(() => undefined)
  }, BROWSER_IDLE_MS)
  s.closeTimer.unref?.()
}

/**
 * Kill dell'eventuale ORFANO del bot, dal pid file (argv puri, come G1): se il
 * daemon è morto senza chiudere, il server nel container è ancora vivo e
 * terrà il profilo bloccato. Chiamato al boot e prima di ogni avvio.
 */
async function killOrphanByPidFile(pidFileContent: string | null): Promise<void> {
  const parsed = parseShellPgid(pidFileContent)
  if (!parsed.ok) return
  await runDockerRaw(dockerKillGroupArgv(BOX_CONTAINER, parsed.pgid, 'TERM'), { timeoutMs: 15_000 }).catch(() => undefined)
}

export async function killBrowserOrphan(agentId: string): Promise<void> {
  if (sandboxMode() !== 'docker') return
  const home = boxHomePath(agentId)
  // best effort: senza container o senza pid file non c'è nessun orfano
  const r = await runDockerRaw(dockerReadFileArgv(BOX_CONTAINER, `${home}/${BROWSER_PID_FILE}`), { timeoutMs: 15_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return
  await killOrphanByPidFile(r.stdout)
}

/** Al boot del daemon: kill degli orfani di TUTTI i bot (solo docker). */
export async function killBrowserOrphans(agentIds: ReadonlyArray<string>): Promise<void> {
  if (sandboxMode() !== 'docker') return
  for (const id of agentIds) await killBrowserOrphan(id).catch(() => undefined)
}

/**
 * L'istanza browser di un bot, AVVIO LAZY: docker exec col wrapper costante
 * (o `node <path>` col flag di test). Prima dell'avvio: container, home e kill
 * dell'orfano. Oltre BROWSERS_PER_BOX_MAX istanze non si parte (Chromium pesa).
 */
async function getBrowserSession(agentId: string): Promise<BrowserSession> {
  const existing = sessions.get(agentId)
  if (existing) {
    touchSession(agentId, existing)
    return existing
  }
  if (sessions.size >= BROWSERS_PER_BOX_MAX) {
    throw new Error(`Limite raggiunto: al massimo ${BROWSERS_PER_BOX_MAX} browser contemporanei per box (Chromium pesa e il box ha memoria condivisa). Chiudine uno con browser_close o riprova più tardi.`)
  }
  const proxyPort = await ensureBrowserProxy()
  let command = 'docker'
  let args: string[]
  const fakeMcp = process.env.SANDBOT_TEST_FAKE_BROWSER_MCP
  if (fakeMcp) {
    // MODALITÀ TEST: il server MCP finto al posto di docker exec — SOLO il suo
    // path, senza i flag (sono del server vero e node li leggerebbe come suoi;
    // il wrapper e il pid file restano un percorso docker: qui non ci sono orfani)
    command = 'node'
    args = [fakeMcp]
  } else {
    await ensureBoxContainer()
    await ensureBotHome(agentId) // -w punta alla home del bot
    await killBrowserOrphan(agentId)
    args = dockerBrowserMcpArgv(agentId, proxyPort)
  }
  const client = new Client({ name: 'sandbot', version: '0.1.0' })
  await client.connect(new StdioClientTransport({ command, args }))
  const session: BrowserSession = {
    client, snapshot: '', url: '', lastActionAt: Date.now(), closeTimer: setTimeout(() => undefined, BROWSER_IDLE_MS)
  }
  sessions.set(agentId, session)
  touchSession(agentId, session)
  return session
}

/** Il testo di un result MCP (parti text, come il client dei connettori). */
function mcpText(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content
  return (content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n')
}

export interface BrowserToolResult {
  output: string
  meta: Record<string, unknown>
}

/**
 * Esegue un tool del browser mappandolo sulla chiamata MCP (punto 2). I tool
 * che riportano contenuto di pagina (snapshot) portano meta.browserPage: il
 * loop lo incarta nel blocco evidenza e contamina il turno. Lo screenshot
 * salva il file nel box e dà il path: nessun contenuto di pagina in contesto.
 */
export async function callBrowserTool(agentId: string, tool: string, input: Record<string, unknown>): Promise<BrowserToolResult> {
  const session = await getBrowserSession(agentId)
  const ref = String(input.ref ?? '')
  let mcpName: string
  let mcpArgs: Record<string, unknown>
  switch (tool) {
    case 'browser_open': {
      // URL validato con checkUrl (come web_fetch): solo http/https, niente credenziali
      const check = checkUrl(String(input.url ?? ''))
      if (!check.ok) return { output: `URL non valido: ${check.reason}`, meta: { browserError: true } }
      mcpName = 'browser_navigate'
      mcpArgs = { url: check.url.toString() }
      break
    }
    case 'browser_snapshot':
      mcpName = 'browser_snapshot'
      mcpArgs = { ...(ref ? { target: ref } : {}), ...(input.depth !== undefined ? { depth: Number(input.depth) } : {}) }
      break
    case 'browser_click':
      mcpName = 'browser_click'
      mcpArgs = { target: ref }
      break
    case 'browser_type': {
      const text = String(input.text ?? '')
      mcpName = 'browser_type'
      mcpArgs = { target: ref, text, ...(input.submit === true ? { submit: true } : {}) }
      break
    }
    case 'browser_select':
      mcpName = 'browser_select_option'
      mcpArgs = { target: ref, values: Array.isArray(input.values) ? input.values.map(String) : [] }
      break
    case 'browser_press_key':
      mcpName = 'browser_press_key'
      mcpArgs = { key: String(input.key ?? '') }
      break
    case 'browser_back':
      mcpName = 'browser_navigate_back'
      mcpArgs = {}
      break
    case 'browser_wait': {
      const text = input.text !== undefined ? String(input.text) : undefined
      const seconds = input.seconds !== undefined ? Math.min(BROWSER_WAIT_MAX_SEC, Math.max(0, Number(input.seconds))) : undefined
      if (!text && seconds === undefined) {
        return { output: 'browser_wait serve almeno un testo da aspettare o i secondi (al massimo 30).', meta: { browserError: true } }
      }
      mcpName = 'browser_wait_for'
      mcpArgs = { ...(text ? { text } : {}), ...(seconds !== undefined ? { time: seconds } : {}) }
      break
    }
    case 'browser_tabs': {
      mcpName = 'browser_tabs'
      const action = String(input.action ?? '')
      mcpArgs = { action, ...(input.index !== undefined ? { index: Number(input.index) } : {}), ...(input.url !== undefined ? { url: String(input.url) } : {}) }
      break
    }
    case 'browser_screenshot': {
      // il nome del file è RELATIVO alla workspace root del server MCP (la
      // home del bot): finisce in .browser/screens/<id>.png nel box
      const filename = `.browser/screens/${randomUUID().slice(0, 8)}.png`
      const res = await session.client.callTool({ name: 'browser_take_screenshot', arguments: { filename, type: 'png' } })
      const raw = mcpText(res)
      const path = `${boxHomePath(agentId)}/${filename}`
      return { output: `Screenshot salvato nel box: ${path}${raw ? `\n${raw.slice(0, 500)}` : ''}`, meta: { screenshot: path } }
    }
    case 'browser_close':
      mcpName = 'browser_close'
      mcpArgs = {}
      break
    default:
      throw new Error(`Tool browser sconosciuto: ${tool}`)
  }
  const res = await session.client.callTool({ name: mcpName, arguments: mcpArgs })
  const raw = mcpText(res)
  // lo stato del bot si aggiorna dal result: l'URL corrente della pagina e
  // l'ultimo snapshot (se il result ne porta uno) sono la verità per i ref
  const pageUrl = browserPageUrl(raw)
  if (pageUrl) session.url = pageUrl
  else if (tool === 'browser_open') session.url = String(mcpArgs.url ?? session.url)
  if (raw.includes('[ref=')) session.snapshot = raw.slice(0, 200_000)
  const truncated = truncateSnapshot(raw)
  const challenge = snapshotChallenge(raw)
  const output = challenge ? `${truncated.text}\n\n${SNAPSHOT_BLOCKED_NOTE}` : truncated.text
  return {
    output,
    meta: {
      browserPage: true,
      url: session.url,
      ...(truncated.truncated ? { snapshotTruncated: true } : {}),
      ...(challenge ? { challenge: true } : {})
    }
  }
}
