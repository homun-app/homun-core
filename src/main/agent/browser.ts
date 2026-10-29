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
// non muore da solo). Il trasporto che si chiude toglie SUBITO la sessione e
// l'azione riparte UNA volta con una sessione nuova (solo browser_open ripete:
// le altre dicono di riaprire la pagina). Le azioni NON restituiscono lo
// snapshot inline (0.0.83 lo scrive in un file): lo chiede il daemon e il
// result al modello è il montaggio compatto di righe di pagina + snapshot.
// SOLO in docker con rete bridge: mai un browser sul Mac dell'utente; il flag
// di test SANDBOT_TEST_FAKE_BROWSER_MCP=<path> sostituisce `docker exec …`
// con `node <path>` (verifica d'integrazione, non esiste in produzione).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolDef } from './llm'
import { checkUrl } from './web-guard'
import {
  refInfo, truncateSnapshot, snapshotChallenge, browserPageUrl, composeBrowserResult,
  errorSection, fieldIsCredential, parseEvaluateResult, SNAPSHOT_BLOCKED_NOTE, type RefInfo, type FieldProbeInfo
} from './browser-guard'
import {
  dockerBrowserMcpArgv, BOX_CONTAINER, BROWSER_MOUNT, BROWSER_USER,
  BROWSER_IDLE_MS, BROWSERS_PER_BOX_MAX, boxHomePath, browserPidFile, browserStateDir,
  dockerBrowserReadFileArgv, dockerBrowserWritableArgv, dockerBrowserOldProfileRmArgv,
  dockerBrowserReadB64Argv, dockerBrowserWriteB64Argv, dockerBrowserRmFileArgv,
  dockerKillGroupArgv
} from '../sandbox/docker-argv'
import {
  sandboxMode, browserSandboxOk, ensureBoxContainer, ensureBotHome, runDockerRaw, runDockerArgv,
  boxOwnerOf, isSubagent
} from '../sandbox'
import { ensureBrowserProxy } from './browser-proxy'
import { parseShellPgid } from './shells'
import { randomUUID } from 'node:crypto'

/** Il browser è disponibile? (docker + rete bridge; il flag di test attiva il percorso in host). */
export function browserAvailable(): boolean {
  if (fakeBrowserMcpPath()) return true
  return browserSandboxOk()
}

/**
 * Fase 14 (verifica): il server MCP FINTO del browser sull'host — attivato SOLO
 * da una variabile SANDBOT_TEST_* (SANDBOT_TEST_FAKE_BROWSER_MCP, o l'alias
 * SANDBOT_TEST_FAKE_BROWSER_CMD della fase 14): senza una delle due, in
 * produzione, il percorso non esiste.
 */
export function fakeBrowserMcpPath(): string | null {
  return process.env.SANDBOT_TEST_FAKE_BROWSER_MCP ?? process.env.SANDBOT_TEST_FAKE_BROWSER_CMD ?? null
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
  /**
   * fase 14 (7d-5): i valori compilati da fill_credential (username, password,
   * TOTP). Vivono qui PER BOT per la vita della sessione del browser: OGNI
   * result di tool di quel bot passa da redactBrowserSecrets, quindi uno
   * snapshot successivo non li rivela. Con la sessione se ne vanno.
   */
  filledValues: string[]
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
  sessionFlights.clear()
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
 * P2 (fase 14 correzioni): il pid file sta nel volume /browser (di 1001) e il
 * processo è di pwuser — lettura E kill girano come 1001:1001 (un kill come
 * 1000 riceverebbe EPERM e l'orfano terrebbe il SingletonLock del profilo).
 */
async function killOrphanByPidFile(pidFileContent: string | null): Promise<void> {
  const parsed = parseShellPgid(pidFileContent)
  if (!parsed.ok) return
  await runDockerRaw(dockerKillGroupArgv(BOX_CONTAINER, parsed.pgid, 'TERM', BROWSER_USER), { timeoutMs: 15_000 }).catch(() => undefined)
}

export async function killBrowserOrphan(agentId: string): Promise<void> {
  if (sandboxMode() !== 'docker') return
  // fase 12 (punto 1): il pid file di un FIGLIO sta nella cartella del padre
  // e porta il suo id nel nome
  const owner = boxOwnerOf(agentId)
  const child = isSubagent(agentId)
  const pidFile = browserPidFile(owner, child ? agentId : undefined)
  // best effort: senza container o senza pid file non c'è nessun orfano
  const r = await runDockerRaw(dockerBrowserReadFileArgv(BOX_CONTAINER, pidFile), { timeoutMs: 15_000 }).catch(() => null)
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
 * SINGLE-FLIGHT per bot: due chiamate concorrenti condividono la stessa
 * partenza, mai due server per lo stesso bot (I4).
 */
const sessionFlights = new Map<string, Promise<BrowserSession>>()

async function startBrowserSession(agentId: string): Promise<BrowserSession> {
  if (sessions.size >= BROWSERS_PER_BOX_MAX) {
    throw new Error(`Limite raggiunto: al massimo ${BROWSERS_PER_BOX_MAX} browser contemporanei per box (Chromium pesa e il box ha memoria condivisa). Chiudine uno con browser_close o riprova più tardi.`)
  }
  const proxyPort = await ensureBrowserProxy()
  let command = 'docker'
  let args: string[]
  let env: Record<string, string> | undefined
  const fakeMcp = fakeBrowserMcpPath()
  if (fakeMcp) {
    // MODALITÀ TEST: il server MCP finto al posto di docker exec — SOLO il suo
    // path, senza i flag (sono del server vero e node li leggerebbe come suoi;
    // il wrapper e il pid file restano un percorso docker: qui non ci sono orfani)
    command = 'node'
    args = [fakeMcp]
    // flag del finto per la sessione morta (I4): la N-esima chiamata muore senza
    // rispondere. Si consuma QUI (una morte sola: le sessioni dopo restano vive)
    const dieOnCall = process.env.SANDBOT_TEST_FAKE_BROWSER_MCP_DIE_ON_CALL
    if (dieOnCall) {
      env = { SANDBOT_TEST_FAKE_BROWSER_MCP_DIE_ON_CALL: dieOnCall }
      delete process.env.SANDBOT_TEST_FAKE_BROWSER_MCP_DIE_ON_CALL
    }
  } else {
    await ensureBoxContainer()
    await ensureBotHome(agentId) // la home del proprietario serve ai file del BOT
    await killBrowserOrphan(agentId)
    // P2 (fase 14 correzioni): il terreno del browser — TUTTO nello stato di
    // 1001 nel volume /browser. Il controllo come 1001 (radice di 1001 e
    // scrivibile) è la verifica del one-shot della radice che ensureBoxContainer
    // gira a ogni (ri)creazione; il profilo VECCHIO rimasto nella home del bot
    // (fase 14 7a) si cancella COME 1000: file del bot, nessun privilegio, e
    // un rm di una cartella assente non costa nulla
    const child = isSubagent(agentId)
    const owner = boxOwnerOf(agentId)
    const w = await runDockerRaw(dockerBrowserWritableArgv(BOX_CONTAINER), { timeoutMs: 15_000 })
    if (w.exitCode !== 0) {
      throw new Error(`il volume del browser non è di ${BROWSER_USER} e 0700 (test -O/-w /browser fallito come 1001): lo stato del browser non è sicuro, il browser non parte. I volumi non sono stati toccati.`)
    }
    if (!child) {
      const rm = await runDockerRaw(dockerBrowserOldProfileRmArgv(BOX_CONTAINER, owner), { timeoutMs: 30_000 })
      if (rm.exitCode !== 0) {
        throw new Error(`rimozione del profilo vecchio del browser non riuscita: ${rm.stderr || `exit ${rm.exitCode}`}`)
      }
    }
    // fase 12 (punto 1) + P2: il browser di un FIGLIO ha istanza e pid file
    // SUOI (--isolated, output- e pid col suo id) ma gira ANCH'ESSO come 1001
    // nello stato del PADRE (/browser/<owner>)
    args = dockerBrowserMcpArgv(agentId, proxyPort, { child, owner })
  }
  const client = new Client({ name: 'sandbot', version: '0.1.0' })
  await client.connect(new StdioClientTransport(env ? { command, args, env } : { command, args }))
  const session: BrowserSession = {
    client, snapshot: '', url: '', lastActionAt: Date.now(), closeTimer: setTimeout(() => undefined, BROWSER_IDLE_MS), filledValues: []
  }
  // I4: il trasporto chiuso (server morto o idle timeout del server) toglie la
  // sessione dalla mappa e ferma il suo timer, subito — mai "Not connected"
  // per i dieci minuti del timer nostro
  client.onclose = () => {
    clearTimeout(session.closeTimer)
    if (sessions.get(agentId) === session) sessions.delete(agentId)
  }
  sessions.set(agentId, session)
  touchSession(agentId, session)
  return session
}

async function getBrowserSession(agentId: string): Promise<BrowserSession> {
  const existing = sessions.get(agentId)
  if (existing) {
    touchSession(agentId, existing)
    return existing
  }
  const inFlight = sessionFlights.get(agentId)
  if (inFlight) return inFlight
  const p = startBrowserSession(agentId).finally(() => {
    sessionFlights.delete(agentId)
  })
  sessionFlights.set(agentId, p)
  return p
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
 * Le azioni che possono cambiare la pagina (I3): dopo ognuna il daemon chiama
 * browser_snapshot, perché le azioni di Playwright MCP 0.0.83 scrivono lo
 * snapshot in un FILE (il result porta solo il link) e senza chiederlo a parte
 * il modello non vedrebbe mai la pagina né i ref.
 */
const SNAPSHOT_AFTER_ACTIONS = new Set([
  'browser_open', 'browser_click', 'browser_type', 'browser_select',
  'browser_press_key', 'browser_back', 'browser_tabs', 'browser_wait'
])

/** L'errore di una sessione morta: il trasporto chiuso rigetta così (I4). */
const isConnectionError = (e: unknown): boolean =>
  /connection closed|not connected/i.test(e instanceof Error ? e.message : String(e))

// ---- fase 12 (0a): il tipo di campo letto DENTRO la pagina ----

/**
 * La funzione COSTANTE della verifica interna del campo (0a): lo schema reale
 * di browser_evaluate nella 0.0.83 è {function, target?, element?} — obbligatorio
 * solo `function`. La funzione è del daemon, MAI del modello: il result non
 * entra nel contesto, non contamina e non aggiorna lo snapshot.
 * Giro K1: si allinea al NOME ACCESSIBILE (Chromium calcola l'accname
 * completo nello snapshot — il probe serve ai campi SENZA nome): TUTTE le
 * label dell'elemento (in quotes.toscrape.com/login il campo username ne ha
 * DUE, "Username" e "Password"), aria-label più il testo degli elementi di
 * aria-labelledby risolti per id, e il title dell'elemento.
 * P3 (fase 14 correzioni): il probe riporta anche l'ORIGINE del FRAME del
 * campo (location.origin del documento che lo contiene) e se il campo sta nel
 * documento TOP — l'origine si verifica al momento del fill, non sull'ultima
 * URL nota della sessione (che per browser_open è l'URL richiesta, non quella
 * finale dopo i redirect).
 */
export const FIELD_PROBE_FN =
  "(el) => ({ type: el.type || '', autocomplete: el.autocomplete || '', name: el.name || '', id: el.id || '', placeholder: el.placeholder || '', label: Array.from(el.labels || []).map((l) => l.textContent || '').join(' '), aria: [el.getAttribute('aria-label') || ''].concat((el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map((i) => (document.getElementById(i) || {}).textContent || '')).join(' ').trim(), title: el.title || '', origin: (el.ownerDocument && el.ownerDocument.defaultView) ? el.ownerDocument.defaultView.location.origin : '', top: !!(el.ownerDocument && el.ownerDocument.defaultView && el.ownerDocument.defaultView.top && el.ownerDocument.defaultView === el.ownerDocument.defaultView.top) })"

/**
 * Chiama INTERNAMENTE browser_evaluate sul campo del ref (0a): serve al
 * daemon per sapere se browser_type finisce in un campo di credenziali anche
 * quando il campo NON ha nome accessibile nello snapshot. Mai esposto al
 * modello: il result non entra nel contesto. ok:false su errore MCP o result
 * non leggibile (il chiamante in quel caso chiede all'utente, mai free).
 * Correzione J3: il result reale della 0.0.83 è markdown (`### Result` col
 * JSON, poi `### Ran Playwright code` e `### Page`), NON JSON nudo — lo
 * legge il parser puro parseEvaluateResult.
 */
export async function probeFieldType(
  agentId: string,
  ref: string
): Promise<{ ok: true; info: FieldProbeInfo } | { ok: false }> {
  try {
    const session = await getBrowserSession(agentId)
    const res = await session.client.callTool({
      name: 'browser_evaluate',
      arguments: { function: FIELD_PROBE_FN, target: ref }
    })
    if ((res as { isError?: boolean }).isError) return { ok: false }
    const info = parseEvaluateResult(mcpText(res))
    return info ? { ok: true, info } : { ok: false }
  } catch {
    return { ok: false }
  }
}

/** Il tipo di campo del ref è di credenziali/pagamento? (0a, per il loop). */
export async function fieldIsCredentialRef(agentId: string, ref: string): Promise<boolean | null> {
  const probe = await probeFieldType(agentId, ref)
  return probe.ok ? fieldIsCredential(probe.info) : null
}

/**
 * Esegue un tool del browser mappandolo sulla chiamata MCP (punto 2). I tool
 * che riportano contenuto di pagina (snapshot) portano meta.browserPage: il
 * loop lo incarta nel blocco evidenza e contamina il turno. Lo screenshot
 * salva il file nel box e dà il path: nessun contenuto di pagina in contesto.
 * I4: un errore di connessione (server morto) toglie la sessione e RIPROVA UNA
 * volta con una sessione nuova — ma SOLO browser_open ripete l'azione: un click
 * ripetuto su un browser nuovo agirebbe su una pagina diversa, quindi le altre
 * azioni ricevono il result che dice di riaprire la pagina.
 */
export async function callBrowserTool(agentId: string, tool: string, input: Record<string, unknown>): Promise<BrowserToolResult> {
  try {
    return await runBrowserTool(agentId, tool, input)
  } catch (e) {
    if (!isConnectionError(e)) throw e
    const msg = e instanceof Error ? e.message : String(e)
    await closeBrowser(agentId) // via la sessione morta (e il suo timer)
    if (tool !== 'browser_open') {
      return {
        output: `Errore del browser: ${msg}. La sessione è stata riavviata e lo stato della pagina è perso: riapri la pagina con browser_open, poi ripeti l'azione.`,
        meta: { browserError: true, browserRestarted: true }
      }
    }
    return await runBrowserTool(agentId, tool, input) // UNA volta, sessione NUOVA
  }
}

/**
 * La copia dello screenshot dal volume PRIVATO del browser alla home del bot
 * (P2, fase 14 correzioni), in tre argv puri di docker-argv: lettura dei byte
 * COME 1001 (base64: il PNG nel canale stdout di una stringa JS non si
 * corrompe), scrittura atomica COME 1000 nella home del bot (temporaneo nella
 * stessa cartella + rename, la forma di DOCKER_WRITE_SH) e cancellazione
 * dell'originale COME 1001. Torna null se tutto è andato bene, altrimenti
 * l'errore CHIARO (mai contenuti di pagina). Esportata per i test (runner
 * docker finto): il flusso dal vivo lo prova il revisore.
 */
export async function copyBrowserScreenshot(owner: string, name: string, dest: string): Promise<string | null> {
  const src = `${browserStateDir(owner)}/${name}`
  const read = await runDockerArgv(dockerBrowserReadB64Argv(BOX_CONTAINER, src), { timeoutMs: 30_000 })
  if (read.exitCode !== 0) return `lettura dello screenshot nel volume del browser non riuscita: ${read.stderr || `exit ${read.exitCode}`}`
  // base64 troncato dal tetto dell'output = PNG corrotto: meglio fermarsi
  if (read.trimmed) return 'screenshot troppo grande per la copia (lettura troncata): riprova con una pagina più semplice'
  const write = await runDockerArgv(dockerBrowserWriteB64Argv(BOX_CONTAINER, dest), { timeoutMs: 30_000, input: read.stdout })
  if (write.exitCode !== 0) return `scrittura dello screenshot nella home del bot non riuscita: ${write.stderr || `exit ${write.exitCode}`}`
  const rm = await runDockerArgv(dockerBrowserRmFileArgv(BOX_CONTAINER, src), { timeoutMs: 30_000 })
  if (rm.exitCode !== 0) return `cancellazione dell'originale nello stato del browser non riuscita: ${rm.stderr || `exit ${rm.exitCode}`}`
  return null
}

async function runBrowserTool(agentId: string, tool: string, input: Record<string, unknown>): Promise<BrowserToolResult> {
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
    }    case 'browser_select':
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
      // P2 (fase 14 correzioni): lo screenshot nasce nello STATO PRIVATO del
      // browser (cwd del server = /browser/<owner>, di 1001: lì non arriva la
      // shell del bot) e il DAEMON lo copia nella home del bot — lettura come
      // 1001, scrittura atomica come 1000, cancellazione dell'originale come
      // 1001. Il modello vede lo STESSO path di prima; uno screenshot mostra i
      // campi password mascherati, ma comunque non resta nel volume privato.
      const id = randomUUID().slice(0, 8)
      const owner = boxOwnerOf(agentId)
      const name = `screenshot-${id}.png`
      const res = await session.client.callTool({ name: 'browser_take_screenshot', arguments: { filename: name, type: 'png' } })
      // fase 12 (0c): al modello solo il path del file e l'eventuale errore —
      // niente `### Ran Playwright code` né link alle uscite del server
      const err = errorSection(mcpText(res))
      const dest = `${boxHomePath(owner)}/.browser/screens/${id}.png`
      if (fakeBrowserMcpPath()) {
        // MODALITÀ TEST (server finto sull'host): nessun file vero da copiare
        return { output: `Screenshot salvato nel box: ${dest}${err ? `\n${err}` : ''}`, meta: { screenshot: dest } }
      }
      const copyErr = await copyBrowserScreenshot(owner, name, dest)
      if (copyErr) return { output: copyErr, meta: { browserError: true } }
      return { output: `Screenshot salvato nel box: ${dest}${err ? `\n${err}` : ''}`, meta: { screenshot: dest } }
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
  // I3: lo snapshot per lo stato e per il modello si chiede A PARTE dopo le
  // azioni (l'azione lo scrive in un file); anche dopo un errore dell'azione,
  // perché la pagina può essere cambiata lo stesso. browser_snapshot invece lo
  // restituisce inline: aggiorna lo stato direttamente
  let snapshotRaw = ''
  if (SNAPSHOT_AFTER_ACTIONS.has(tool)) {
    const snap = await session.client.callTool({ name: 'browser_snapshot', arguments: {} })
    snapshotRaw = mcpText(snap)
    // 7d-5: lo snapshot di STATO passa dalla redazione (un "mostra password"
    // seguito da uno snapshot non rivela il valore compilato)
    if (snapshotRaw) session.snapshot = redactBrowserSecrets(agentId, snapshotRaw).slice(0, 200_000)
  } else if (raw.includes('[ref=')) {
    session.snapshot = redactBrowserSecrets(agentId, raw).slice(0, 200_000)
  }
  // l'URL corrente: dal result dell'azione, o dallo snapshot ricevuto a parte
  const pageUrl = browserPageUrl(raw) ?? browserPageUrl(snapshotRaw)
  if (pageUrl) session.url = pageUrl
  else if (tool === 'browser_open') session.url = String(mcpArgs.url ?? session.url)
  // il result al modello è COMPATTO e uguale per tutte le azioni: righe di
  // pagina ed eventuali Error/Modal state dall'azione, più lo snapshot inline
  // — e passa dalla REDAZIONE dei valori compilati (7d-5)
  const composed = SNAPSHOT_AFTER_ACTIONS.has(tool) ? composeBrowserResult(raw, snapshotRaw) : raw
  const redacted = redactBrowserSecrets(agentId, composed)
  const truncated = truncateSnapshot(redacted)
  const challenge = snapshotChallenge(redacted)
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

// ---- fase 14 (punto 7d): il fill dei campi col valore del vault ----

/**
 * Il DAEMON compila un campo col valore del login (7d-4): chiama browser_type
 * di Playwright MCP col valore; il result GREZZO (che contiene il codice
 * Playwright col valore) NON torna né al modello né al transcript — SI BUTTA.
 * Il valore entra nella lista di redazione del bot (7d-5), che vive quanto la
 * sessione del browser.
 */
export async function typeIntoFieldForFill(agentId: string, ref: string, value: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!value) return { ok: false, error: 'valore vuoto: niente da scrivere nel campo' }
  try {
    const session = await getBrowserSession(agentId)
    const res = await session.client.callTool({ name: 'browser_type', arguments: { target: ref, text: value } })
    // 7d-4: il result contiene il codice Playwright col valore — non si legge
    // nemmeno per l'errore: si guarda solo isError
    if ((res as { isError?: boolean }).isError) {
      return { ok: false, error: 'la scrittura nel campo non è riuscita (errore del server MCP del browser)' }
    }
    registerFilledValues(agentId, [value])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Registra i valori compilati per la redazione (7d-5): vita della sessione. */
export function registerFilledValues(agentId: string, values: string[]): void {
  const s = sessions.get(agentId)
  if (!s) return
  for (const v of values) {
    if (v && !s.filledValues.includes(v)) s.filledValues.push(v)
  }
}

/** I valori compilati di un bot (per i test e la verifica). */
export function filledValuesOf(agentId: string): string[] {
  return [...(sessions.get(agentId)?.filledValues ?? [])]
}

/**
 * redactBrowserSecrets (7d-5): oscura i valori compilati in OGNI result di
 * tool del bot (snapshot, testo di pagina, comandi, web): un "mostra password"
 * seguito da uno snapshot non rivela niente. Oltre al valore letterale oscura
 * le codifiche più comuni (come redactSecrets dei comandi).
 */
export function redactBrowserSecrets(agentId: string, text: string): string {
  const s = sessions.get(agentId)
  if (!s || !s.filledValues.length) return text
  let out = text
  for (const v of s.filledValues) {
    if (!v) continue
    for (const x of [v, Buffer.from(v, 'utf8').toString('base64'), encodeURIComponent(v)]) {
      if (x && x.length >= 4) out = out.split(x).join('[redacted:credential]')
    }
  }
  return out
}
