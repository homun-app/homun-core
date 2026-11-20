// Client MCP — i server MCP (stdio o HTTP) diventano tool dinamici dell'agente,
// con nomi mcp__<server>__<tool> come i tool esterni dell'originale (discover-ai-tool).
//
// Fase 5: i server HTTP possono autenticarsi con OAuth (OAuthClientProvider,
// connettori del catalogo) o con header statici/bearer salvati CIFRATI nello
// store dei connettori (mai nei settings in chiaro). Le annotazioni standard
// dei tool (readOnlyHint/destructiveHint/openWorldHint) alimentano il gate dei
// permessi (permissions.ts); i tool disattivati per connettore non vengono
// offerti al modello; un token scaduto manda il connettore in 'needs_auth'.
// Fase 6 (residuo 0a): l'auto-allow da readOnlyHint vale solo per i server
// del catalogo (quelli con catalogId), non per i server manuali.
// Fase 13: i server hanno enabledFor (quali bot li vedono — serversForAgent);
// i server stdio del registro e dei plugin girano NEL BOX via docker exec
// (cfg.box: codice di terzi MAI sul Mac); i server del registro/plugin/gateway
// (cfg.source) NON hanno auto-consenso dalle annotazioni (niente catalogId);
// un server in attesa di chiavi/variabili (needsAuth) non è offerto al modello.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
// fase rilascio (A7): docker fuori dal PATH del Terminale
import { activeBoxEngine } from '../sandbox/engine'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { getSetting, setSetting } from '../store/db'
import { setMcpAnnotationsLookup } from '../agent/permissions'
// fase Composio OAuth (C3): l'elenco CHIUSO degli strumenti del server Composio
import { composioToolPolicy } from '../connectors/composio-meta'
import { mcpCallIsRead } from '../connectors/tool-batch'
import { callMcpWithRetry } from './retry'
// E1 (fase mcp-env): il PATH dei comandi dei server stdio manuali
import { lookupServerCommand } from './command-path'
// E4 (fase mcp-env): l'uscita di rete dei server npm nel box (proxy per-server)
import { ensureMcpEgressProxy, ensureMcpEgressProxyGateway, mcpEgressEnv, mcpEgressAllowHosts } from './egress-proxy'
import { COMPOSIO_MULTI_EXECUTE_TOOL, forceSyncResponseToWorkbenchOff } from '../connectors/tool-batch'
import { boxOwnerOf, ensureBoxContainer, ensureBotHome } from '../sandbox'
// E4 (fase mcp-env): la rete del box (il gateway Apple decide l'indirizzo del proxy)
import { sandboxNetwork } from '../sandbox'
// N1 (fase mcp-egress-sicurezza): i server npm non verificati partono solo se
// il motore garantisce che il proxy è l'unica uscita
import { boxShellEgressOf } from '../sandbox'
import { NPM_SERVERS_EGRESS_REFUSED } from '../sandbox/box-egress'
import type { ToolDef } from '../agent/llm'
// fase 17c (C3/C5): lo stato needs_auth che la UI mostra è nel catalogo UI; trustKind per la vista Installati
import { uiText } from '../ui-language'
import { UI } from '../../shared/ui-messages'

export interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string   // stdio
  args?: string[]    // stdio
  url?: string       // http
  enabled: boolean
  /** fase 5: autenticazione del server http — i segreti stanno nello store cifrato */
  auth?: { kind: 'oauth' | 'bearer' | 'headers' }
  /** fase 5: id del connettore del catalogo (per stato/tool disattivati) */
  catalogId?: string
  /** fase 13 (punto 5): per quali bot è abilitato il server (['*'] = tutti) */
  enabledFor?: string[]
  /** fase 13: da dove arriva il server (registro pubblico, plugin, gateway) */
  source?:
    | { kind: 'registry'; name: string; version?: string }
    | { kind: 'plugin'; plugin: string; marketplace: string; sha: string }
    | { kind: 'gateway'; preset?: string }
    /** E4 (fase mcp-env): pacchetto npm proposto dal bot, versione FISSATA */
    | { kind: 'npm'; package: string; version: string; allowHosts?: string[] }
  /**
   * fase 13 (punto 2): server stdio che gira NEL BOX — docker exec con utente
   * e workdir del bot; `envKeys` passano come `-e NOME` col valore preso
   * dall'ambiente del processo figlio, MAI in argv (regola dei segreti).
   * `home` è la home del bot nel box (L1: l'exec porta anche `-e HOME`, come
   * execDocker — senza, la cache di npx finisce nella home di sistema).
   */
  box?: { workdir: string; command: string; args?: string[]; envKeys?: string[]; home?: string }
  /**
   * fase 13 (correzione L1): la dichiarazione del server di PLUGIN (template
   * pubblici del repository, placeholder NON sostituiti): url, headers ed env
   * si ricalcolano alla connessione con i valori ${user_config.KEY} dello store.
   * Mai un valore dell'utente qui dentro.
   */
  pluginSpec?: { url?: string; headers?: Record<string, string>; env?: Record<string, string> }
  /**
   * E1 (fase mcp-env): le VARIABILI del server stdio MANUALE — solo la
   * DICHIARAZIONE (nome + segreto sì/no) e i valori NON segreti (envValues);
   * i valori SEGRETI vivono solo nello store cifrato (kind 'env'), mai qui.
   */
  envSpec?: Array<{ name: string; secret: boolean }>
  /** E1: i valori NON segreti delle variabili dichiarate in envSpec */
  envValues?: Record<string, string>
  /**
   * E4 (fase mcp-env): l'USCITA DI RETE del server nel box — solo gli host
   * dichiarati (+ registry.npmjs.org finché non installato), dal proxy
   * per-server; installedAt al primo avvio riuscito.
   */
  egress?: { allowHosts: string[]; installedAt?: number }
  /**
   * fase mcp-setup (M1): il template `{var}` dell'URL di un remote del
   * registro (pubblico, dal registro stesso) e i valori NON segreti delle
   * variabili. I segreti stanno nello store cifrato; l'URL si risolve alla
   * connessione (buildMcpAuthResolver). Mai un segreto qui dentro.
   */
  urlTemplate?: string
  /** fase mcp-setup (M1): i valori NON segreti delle variabili del template (per esempio mattermost_host) */
  vars?: Record<string, string>
  /**
   * fase mcp-setup (M1): i template degli header del registro (pubblici). Il
   * VALORE risolto di un header segreto si salva nello store cifrato (kind
   * headers); qui resta solo il template.
   */
  headerTemplates?: Array<{ name: string; valueTemplate: string; isRequired?: boolean; isSecret?: boolean; description?: string; variables?: Array<{ name: string; description?: string; isSecret?: boolean }> }>
  /**
   * fase 13: installato ma in attesa di valori che l'utente inserisce nelle
   * Impostazioni; fase mcp-setup (M1): 'setup' = il modulo della card/foglio
   * (variabili dell'URL o accesso da fare).
   */
  needsAuth?: { kind: 'key' | 'env' | 'settings' | 'setup'; keys: string[] }
  /** fase 13: fiducia mostrata nella scheda Installati (dominio verificato, …) */
  trustLabel?: string
  /** fase 17c (C5): il kind della fiducia — la UI lo traduce */
  trustKind?: 'verified-domain' | 'github-account' | 'unverified'
  /**
   * fase mcp-setup ritocchi (R1): il prefisso STABILE degli strumenti
   * (mcp__&lt;toolSlug&gt;__…), deciso UNA VOLTA all'installazione e mai più
   * cambiato — il nome mostrato (cfg.name) può cambiare (titolo del registro)
   * senza perdere permessi, disabledTools e riferimenti, che stanno per nome
   * completo. Massimo 24 caratteri: mcp__&lt;slug&gt;__&lt;tool&gt; deve stare nei 64
   * dei provider. Senza campo (i server di PRIMA della migrazione del
   * catalogo) vale slug(cfg.name), che per loro non cambia mai.
   */
  toolSlug?: string
}

/**
 * serversForAgent (pura, punto 5): i server abilitati per un bot. enabledFor
 * contiene '*' oppure l'id del bot; un FIGLIO eredita dal padre (boxOwnerOf).
 * I server esistenti prima della migrazione hanno enabledFor indefinito →
 * valgono per tutti (il daemon li migra a ['*'] al primo avvio).
 */
export function serversForAgent(servers: McpServerConfig[], agentId: string, parentId?: string): McpServerConfig[] {
  return servers.filter((s) => {
    const ids = s.enabledFor ?? ['*']
    return ids.includes('*') || ids.includes(agentId) || (parentId !== undefined && ids.includes(parentId))
  })
}

/** Migrazione punto 5: i server ESISTENTI al primo avvio restano per tutti. */
export function migrateEnabledFor(servers: McpServerConfig[]): { servers: McpServerConfig[]; changed: boolean } {
  let changed = false
  const out = servers.map((s) => {
    if (s.enabledFor === undefined) {
      changed = true
      return { ...s, enabledFor: ['*'] as string[] }
    }
    return s
  })
  return { servers: out, changed }
}

/** Annotazioni MCP standard che interessano il gate dei permessi. */
export interface McpAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

// ---- fase Composio OAuth (C3) + K6 (ritocchi): la tabella degli strumenti
// di Composio vale PER NOME su OGNI server, come il gate del blocco: chi
// aggiunge a mano un server MCP verso Composio non riporta i tool nascosti
// (REMOTE_WORKBENCH…). Un nome COMPOSIO_* non in tabella resta NASCOSTO
// (fail closed); i tool senza quel prefisso non si toccano.

/** Uno strumento COMPOSIO_* è tra quelli che Homun offre al modello? */
export function composioToolOffered(originalName: string): boolean {
  return !originalName.startsWith('COMPOSIO_') || composioToolPolicy(originalName).offered
}

/** I tool di UN qualunque server dopo la tabella C3 (fail closed per nome). */
export function offeredMcpTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => composioToolOffered(t.name))
}

/**
 * K6 (ritocchi): i nomi completi degli strumenti del server Composio del
 * catalogo, dal nome VERO del server (mcp__&lt;slug del nome&gt;__…) — il
 * gateway non scrive più lo slug a mano e non si rompe se il server ha un
 * altro nome. Senza server collegato vale lo slug storico «composio».
 */
export function composioServerTools(): { manageConnections: string; waitForConnections: string } {
  const cfg = listServers().find((s) => s.catalogId === 'composio')
  const prefix = `mcp__${cfg ? toolSlugOf(cfg) : 'composio'}`
  return {
    manageConnections: `${prefix}__COMPOSIO_MANAGE_CONNECTIONS`,
    waitForConnections: `${prefix}__COMPOSIO_WAIT_FOR_CONNECTIONS`
  }
}

const CACHE_TTL = 5 * 60_000
interface Cached { client: Client; tools: McpToolInfo[]; at: number; config: McpServerConfig }
const cache = new Map<string, Cached>()

export interface McpToolInfo {
  serverId: string
  serverName: string
  originalName: string
  def: ToolDef
  annotations?: McpAnnotations
}

/** Autenticazione risolta per un server http (provider OAuth o header statici). */
export interface McpAuth {
  authProvider?: OAuthClientProvider
  headers?: Record<string, string>
  /** fase 13 (correzione L1): env del processo figlio per i server stdio NEL BOX (valori MAI in argv) */
  stdioEnv?: Record<string, string>
  /** fase 13 (correzione L1): l'url RISOLTO del server di plugin (placeholder sostituito), se serve */
  url?: string
}
export type McpAuthResolver = (cfg: McpServerConfig) => McpAuth | Promise<McpAuth>
let authResolver: McpAuthResolver = () => ({})

/** Registra il resolver d'autenticazione (il daemon lo collega ai connettori). */
export function setMcpAuthResolver(fn: McpAuthResolver): void {
  authResolver = fn
}

/**
 * L4: la catena container→home→exec del server stdio nel box, iniettabile per
 * i test (il default chiama ensureBoxContainer/ensureBotHome del sandbox): il
 * loader le chiama IN QUELL'ORDINE prima dello StdioClientTransport.
 */
interface BoxEnsurePair {
  ensureBox(): Promise<void>
  ensureHome(agentId: string): Promise<void>
}
const defaultBoxEnsure: BoxEnsurePair = {
  ensureBox: () => ensureBoxContainer(),
  ensureHome: (agentId) => ensureBotHome(agentId)
}
let boxEnsure: BoxEnsurePair = defaultBoxEnsure

/** Solo per i test: sostituisce (o ripristina) la catena ensure del box. */
export function setMcpBoxEnsureForTests(pair: BoxEnsurePair | null): void {
  boxEnsure = pair ?? defaultBoxEnsure
}

/**
 * L4: il proprietario della workdir del server nel box (puro) — la home del
 * bot (/box/home/<id>) per i server del registro, oppure la `home` dichiarata
 * dai server di plugin (la workdir è la cartella del plugin, non la home).
 */
export function boxOwnerOfWorkdir(box: { workdir: string; home?: string }): string | null {
  return /^\/box\/home\/([^/]+)/.exec(box.home ?? box.workdir)?.[1] ?? null
}

/**
 * L1: l'argv del server stdio nel box (puro) — le envKeys sono ESATTAMENTE le
 * chiavi di ciò che il resolver ha risolto (env del registro o env del plugin
 * coi placeholder sostituiti), non l'elenco statico della config.
 */
export function boxStdioArgv(cfg: McpServerConfig, stdioEnv?: Record<string, string>): string[] {
  const box = cfg.box!
  const envKeys = stdioEnv && Object.keys(stdioEnv).length ? Object.keys(stdioEnv) : box.envKeys
  return activeBoxEngine().argv.stdioMcp({ ...box, envKeys })
}

export function listServers(): McpServerConfig[] {
  return getSetting<McpServerConfig[]>('mcp.servers', [])
}

export function saveServers(s: McpServerConfig[]): void {
  setSetting('mcp.servers', s)
}

// R1: gli slug degli strumenti vivono nel modulo leggero mcp/slug.ts (serve
// PURO anche alle migrazioni); qui si riesportano per i consumer di sempre
import { toolSlugOf, serverOfToolName } from './slug'
export { toolSlugOf, assignToolSlug, toolSlugKeeping, serverOfToolName, TOOL_SLUG_MAX } from './slug'

/**
 * Fase mcp-setup (M5.2): il prefisso degli strumenti di un server nella
 * pipeline (mcp__&lt;toolSlug&gt;) — per il messaggio di sistema che dice al bot
 * che l'utente ha completato il collegamento. R1: prende la CONFIG (il prefisso
 * è toolSlugOf, non più lo slug del nome).
 */
export function serverToolsPrefix(cfg: Pick<McpServerConfig, 'toolSlug' | 'name'>): string {
  return `mcp__${toolSlugOf(cfg)}`
}

/** Stato del connettore collegato al server (fase 5), se ce n'è uno. */
function connectorStateOf(cfg: McpServerConfig): { status?: string; disabledTools?: string[] } {
  const id = cfg.catalogId ?? cfg.id
  return getSetting<Record<string, { status?: string; disabledTools?: string[] }>>('connectors.state', {})[id] ?? {}
}

/** Un server in needs_auth/errore non viene offerto al modello (evita retry lenti a ogni turno). */
function skippedByConnectorState(cfg: McpServerConfig): boolean {
  if (cfg.needsAuth) return true // fase 13: aspetta chiavi/variabili dalle Impostazioni
  const status = connectorStateOf(cfg).status
  return status === 'needs_auth' || status === 'error'
}

/** Token scaduto/rifiutato: il connettore va riconnesso dall'utente. */
function markNeedsAuth(cfg: McpServerConfig, message: string): void {
  const id = cfg.catalogId ?? cfg.id
  if (!cfg.catalogId && !cfg.source) return // server manuale senza stato connettore: niente da segnare
  const all = getSetting<Record<string, Record<string, unknown>>>('connectors.state', {})
  const cur = (all[id] ?? {}) as Record<string, unknown>
  setSetting('connectors.state', { ...all, [id]: { ...cur, status: 'needs_auth', error: message } })
}

/**
 * N1 (fase mcp-egress-sicurezza): l'ultima prova del server è FALLITA per un
 * motivo che l'utente deve vedere (es. il motore non garantisce il recinto) —
 * lo stato 'error' col messaggio arriva al foglio del server.
 */
function markStateError(cfg: McpServerConfig, message: string): void {
  const id = cfg.catalogId ?? cfg.id
  if (!cfg.catalogId && !cfg.source) return
  const all = getSetting<Record<string, Record<string, unknown>>>('connectors.state', {})
  const cur = (all[id] ?? {}) as Record<string, unknown>
  setSetting('connectors.state', { ...all, [id]: { ...cur, status: 'error', error: message } })
}

/**
 * E4 (fase mcp-env): l'env di USCITA di un server npm nel box — il proxy
 * per-server (allowlist letta a OGNI richiesta: registry.npmjs.org sparisce
 * da solo appena l'installazione è avvenuta), l'indirizzo come lo vede il
 * box (docker: host.docker.internal; apple: il GATEWAY della rete vmnet) e
 * la cache npm della cartella DEL SERVER. Col motore Apple senza gateway
 * noto la connessione fallisce IN PAROLE, mai un proxy irraggiungibile.
 */
async function egressEnvOf(cfg: McpServerConfig): Promise<Record<string, string>> {
  const egress = cfg.egress!
  const installedNow = (): boolean => listServers().find((s) => s.id === cfg.id)?.egress?.installedAt !== undefined
  const allow = (): readonly string[] => mcpEgressAllowHosts(egress.allowHosts, installedNow())
  const port = await ensureMcpEgressProxy(cfg.id, allow)
  let proxyUrl = `http://host.docker.internal:${port}`
  if (activeBoxEngine().id === 'apple-container' && sandboxNetwork() === 'bridge') {
    const { boxNetworkGateway, boxNetworkSubnet, ensureAppleBoxNetwork } = await import('../sandbox/apple-container-engine')
    const { runDockerRaw } = await import('../sandbox')
    let gw = boxNetworkGateway()
    let subnet = boxNetworkSubnet()
    if (!gw || !subnet) {
      await ensureAppleBoxNetwork(runDockerRaw, 'bridge').catch(() => undefined)
      gw = boxNetworkGateway()
      subnet = boxNetworkSubnet()
    }
    if (!gw || !subnet) {
      throw new Error('the isolated computer network gateway is unknown: this MCP server cannot have a limited network, it does not start')
    }
    const listen = await ensureMcpEgressProxyGateway(cfg.id, allow, gw, subnet)
    proxyUrl = `http://${listen.host}:${listen.port}`
  }
  const base = cfg.box?.home ?? cfg.box?.workdir ?? ''
  return mcpEgressEnv(proxyUrl, `${base}/mcp-npm/${toolSlugOf(cfg)}`)
}

async function connect(cfg: McpServerConfig): Promise<Client> {
  const client = new Client({ name: 'sandbot', version: '0.1.0' })
  if (cfg.transport === 'stdio') {
    if (cfg.box) {
      // N1 (fase mcp-egress-sicurezza): un server npm NON VERIFICATO parte
      // solo se il motore garantisce che il proxy di uscita è l'unica via
      // (rete interna del box). Con Docker (uscita libera) il rifiuto è in
      // parole, PRIMA di ogni exec — e lo stato del connettore lo dice, così
      // il foglio del server lo mostra.
      if (cfg.egress && boxShellEgressOf() !== 'none') {
        markStateError(cfg, NPM_SERVERS_EGRESS_REFUSED)
        throw new Error(NPM_SERVERS_EGRESS_REFUSED)
      }
      // fase 13: server stdio di registro/plugin — gira NEL BOX (docker exec),
      // mai sul Mac; le env col solo NOME in argv, i valori nell'env del figlio.
      // L4: il box esiste PRIMA dell'exec (container, poi home, poi exec — la
      // stessa catena di execDocker), altrimenti su un daemon nuovo l'errore è
      // "No such container" mascherato da "Connection closed"
      const owner = boxOwnerOfWorkdir(cfg.box)
      await boxEnsure.ensureBox()
      if (owner) await boxEnsure.ensureHome(boxOwnerOf(owner))
      const a = await authResolver(cfg)
      // E4 (fase mcp-env): i server npm nel box escono SOLO dal proxy con
      // l'allowlist del server (host dichiarati + registry.npmjs.org finché
      // installa; HTTPS_PROXY/HTTP_PROXY/NO_PROXY + NODE_USE_ENV_PROXY e la
      // cache npm della cartella del server)
      const stdioEnv = cfg.egress ? { ...a.stdioEnv, ...(await egressEnvOf(cfg)) } : a.stdioEnv
      const argv = boxStdioArgv(cfg, stdioEnv)
      await client.connect(
        stdioEnv && Object.keys(stdioEnv).length
          ? new StdioClientTransport({ command: activeBoxEngine().command(), args: argv, env: { ...activeBoxEngine().childEnv(process.env), ...stdioEnv } as Record<string, string> })
          : new StdioClientTransport({ command: activeBoxEngine().command(), args: argv })
      )
      return client
    }
    // E1 (fase mcp-env): i server stdio MANUALI — il comando si risolve
    // (PATH ridotto del Finder + posti noti di fnm/nvm/Homebrew, errore chiaro
    // se manca) e il processo riceve l'env di base di oggi + le variabili
    // dell'utente (non segrete dalla config, segrete dallo store cifrato,
    // entrambe dal resolver come stdioEnv)
    const resolved = lookupServerCommand(cfg.command ?? '')
    if ('error' in resolved) throw new Error(resolved.error)
    const a = await authResolver(cfg)
    await client.connect(
      a.stdioEnv && Object.keys(a.stdioEnv).length
        ? new StdioClientTransport({ command: resolved.command, args: cfg.args ?? [], env: a.stdioEnv })
        : new StdioClientTransport({ command: resolved.command, args: cfg.args ?? [] })
    )
  } else {
    const a = await authResolver(cfg)
    // L1: l'url di un server di plugin arriva RISOLTO dal resolver (i
    // placeholder ${user_config.KEY} non sono un URL valido)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(a.url ?? cfg.url ?? 'http://localhost'), {
        ...(a.authProvider ? { authProvider: a.authProvider } : {}),
        ...(a.headers ? { requestInit: { headers: a.headers } } : {})
      })
    )
  }
  return client
}

async function ensure(cfg: McpServerConfig, force = false): Promise<Cached> {
  const hit = cache.get(cfg.id)
  if (!force && hit && Date.now() - hit.at < CACHE_TTL) return hit
  if (hit) {
    void hit.client.close().catch(() => undefined)
    cache.delete(cfg.id)
  }
  let client: Client
  let res: Awaited<ReturnType<Client['listTools']>>
  try {
    client = await connect(cfg)
    res = await client.listTools()
  } catch (e) {
    // M2: il 401 si scopre OVUNQUE si connetta — anche qui, usato da
    // activeTools all'inizio del turno — non solo in testServer/callTool:
    // altrimenti un token scaduto resterebbe un errore generico ritentato a
    // ogni turno, senza mai il bottone "Riconnetti"
    if (e instanceof UnauthorizedError) markNeedsAuth(cfg, uiText(UI.connTokenExpired))
    throw e
  }
  // fase Composio OAuth (C3) + K6 (ritocchi): la tabella degli strumenti di
  // Composio vale PER NOME su OGNI server (come il gate del blocco). Il
  // server dichiara tools.listChanged: uno strumento COMPOSIO_* NUOVO, che
  // non è in tabella, NON si offre al modello (fail closed) — lo si
  // classifica prima. I nomi senza prefisso restano come sono.
  // E4 (fase mcp-env): il primo avvio riuscito di un server npm INSTALLA il
  // pacchetto nella cache del box — da questo momento il proxy nega anche
  // registry.npmjs.org (l'aggiornamento di versione è una card NUOVA)
  if (cfg.egress && cfg.egress.installedAt === undefined) {
    const all = listServers()
    const i = all.findIndex((x) => x.id === cfg.id)
    if (i !== -1 && all[i]!.egress?.installedAt === undefined) {
      all[i] = { ...all[i]!, egress: { ...all[i]!.egress!, installedAt: Date.now() } }
      saveServers(all)
    }
  }
  const offered = offeredMcpTools(res.tools ?? [])
  const tools: McpToolInfo[] = offered.map((t) => ({
    serverId: cfg.id,
    serverName: cfg.name,
    originalName: t.name,
    def: {
      name: `mcp__${toolSlugOf(cfg)}__${t.name}`,
      description: `[MCP:${cfg.name}] ${t.description ?? ''}`.slice(0, 400),
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
    },
    ...(t.annotations ? { annotations: t.annotations as McpAnnotations } : {})
  }))
  const entry: Cached = { client, tools, at: Date.now(), config: cfg }
  cache.set(cfg.id, entry)
  return entry
}

/** Test connessione + lista tool (per la UI). */
export async function testServer(id: string): Promise<{ ok: boolean; error?: string; tools?: string[] }> {
  const cfg = listServers().find((s) => s.id === id)
  if (!cfg) return { ok: false, error: 'server not found' }
  try {
    const c = await ensure(cfg, true)
    return { ok: true, tools: c.tools.map((t) => t.def.name) }
  } catch (e) {
    if (e instanceof UnauthorizedError) markNeedsAuth(cfg, uiText(UI.connTokenExpired))
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * L2: chiude il client vivo di un server e lo toglie dalla cache — alla
 * disinstallazione, insieme ai segreti, così un server reinstallato non
 * riusa la connessione (e le credenziali) di quello tolto.
 */
export function disconnectServer(id: string): void {
  const hit = cache.get(id)
  cache.delete(id)
  if (hit) void hit.client.close().catch(() => undefined)
}

/** Tool completi di un server (nome, descrizione, annotazioni) per la UI "Connetti app". */
export async function toolsOfServer(id: string): Promise<
  Array<{ name: string; description: string; annotations?: McpAnnotations }>
> {
  const cfg = listServers().find((s) => s.id === id)
  if (!cfg) throw new Error('server not found')
  const c = await ensure(cfg, true)
  return c.tools.map((t) => ({
    name: t.def.name,
    description: t.def.description,
    ...(t.annotations ? { annotations: t.annotations } : {})
  }))
}

/**
 * Tutti i tool MCP abilitati, pronti per il loop agente. Riconnette se scaduti.
 * Fase 13 (punto 5): con agentId restano solo i server abilitati PER QUEL BOT
 * (serversForAgent; un figlio eredita dal padre via boxOwnerOf). Senza agentId
 * (compatibilità) restano tutti.
 * Fase app (A5): in CODA anche gli strumenti Composio (composio__<tk>__<ACTION>),
 * stessa pipeline (enabledFor per toolkit, defer con find_tools oltre la soglia).
 */
export async function activeTools(agentId?: string): Promise<ToolDef[]> {
  const out: ToolDef[] = []
  const owner = agentId !== undefined ? boxOwnerOf(agentId) : undefined
  const servers = agentId !== undefined ? serversForAgent(listServers(), agentId, owner) : listServers()
  for (const cfg of servers.filter((s) => s.enabled && !skippedByConnectorState(s))) {
    try {
      const c = await ensure(cfg)
      const disabled = new Set(connectorStateOf(cfg).disabledTools ?? [])
      out.push(...c.tools.filter((t) => !disabled.has(t.def.name)).map((t) => t.def))
    } catch {
      // server non raggiungibile: lo saltiamo senza rompere il turno
    }
  }
  const { composioToolsForAgent } = await import('../connectors/composio')
  out.push(...composioToolsForAgent(agentId))
  return out
}

/**
 * Fase chat-limiti (CL6): le APP COLLEGATE per gruppo mcp:<server>, sui tool
 * MCP del turno — così find_tools({query: <nome o slug dell'app>}) trova gli
 * strumenti dell'app collegata. Flusso GATEWAY: il server «Composio For You»
 * espone solo i proxy mcp__composio__*, e il gruppo si chiama mcp:composio:
 * senza le app nel testo del gruppo la query «gmail» non trovava niente («No
 * tool groups match» — la prova della beta.5). Flusso SDK: i tool
 * composio__<slug>__* portano lo slug nel proprio gruppo mcp:<slug>.
 */
export async function mcpGroupAppsForAgent(mcpToolDefs: ToolDef[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  if (mcpToolDefs.some((t) => t.name.startsWith('mcp__composio__'))) {
    try {
      const { composioGateway } = await import('../connectors/composio-gateway')
      const apps = (composioGateway()?.status().connected ?? []).filter((a) => a.status === 'ACTIVE')
      if (apps.length) {
        out['mcp:composio'] = apps.flatMap((a) => [a.slug, a.name]).filter(Boolean)
      }
    } catch {
      // gateway non interrogabile: nessuna app nel testo del gruppo
    }
  }
  for (const t of mcpToolDefs) {
    const m = /^composio__(.+?)__/.exec(t.name)
    if (m && !out[`mcp:${m[1]}`]?.length) {
      out[`mcp:${m[1]}`] = [m[1]!]
    }
  }
  return out
}

/**
 * I tool MCP raggruppati per server, per un bot (fase 13, punto 5): serve alla
 * sezione "Connettori attivi" del prompt quando i tool sono deferiti.
 */
export async function activeServersForAgent(agentId?: string): Promise<Array<{ id: string; name: string; tools: ToolDef[] }>> {
  const out: Array<{ id: string; name: string; tools: ToolDef[] }> = []
  const owner = agentId !== undefined ? boxOwnerOf(agentId) : undefined
  const servers = agentId !== undefined ? serversForAgent(listServers(), agentId, owner) : listServers()
  for (const cfg of servers.filter((s) => s.enabled && !skippedByConnectorState(s))) {
    try {
      const c = await ensure(cfg)
      const disabled = new Set(connectorStateOf(cfg).disabledTools ?? [])
      const tools = c.tools.filter((t) => !disabled.has(t.def.name)).map((t) => t.def)
      if (tools.length) out.push({ id: cfg.id, name: cfg.name, tools })
    } catch {
      // server non raggiungibile: saltato
    }
  }
  // fase app (A5): le app Composio come le altre nella sezione «Connettori attivi»
  const { composioServersForAgent } = await import('../connectors/composio')
  for (const s of composioServersForAgent(agentId)) {
    if (s.tools.length) out.push({ id: s.id, name: s.name, tools: s.tools as unknown as ToolDef[] })
  }
  return out
}

/**
 * Fase app (A8): i nomi umani delle APP di un bot — curate collegate, server
 * installati e app Composio — per la riga dei pari del coordinatore (max 8
 * nel prompt; il tetto lo applica group-turns, qui solo i nomi veri).
 */
export async function appsForAgent(agentId?: string): Promise<string[]> {
  const names: string[] = []
  const owner = agentId !== undefined ? boxOwnerOf(agentId) : undefined
  const servers = agentId !== undefined ? serversForAgent(listServers(), agentId, owner) : listServers()
  for (const cfg of servers.filter((s) => s.enabled && !skippedByConnectorState(s))) {
    // fase Composio OAuth (C8): per il server Composio si elencano i TOOLKIT
    // collegati («app: Gmail, Slack (tramite Composio)»), non «Composio»
    if (cfg.catalogId === 'composio') {
      const { composioGateway } = await import('../connectors/composio-gateway')
      const apps = (composioGateway()?.status().connected ?? [])
        .filter((a) => a.status === 'ACTIVE')
        .map((a) => a.name)
      names.push(apps.length ? `${apps.join(', ')} (tramite Composio)` : cfg.name)
      continue
    }
    names.push(cfg.name)
  }
  const { composioAppsOf } = await import('../connectors/composio')
  names.push(...composioAppsOf(agentId))
  return [...new Set(names)]
}

/** Errore di un tool MCP che richiede la riconnessione del connettore (card "Riconnetti"). */
export class McpNeedsReconnectError extends Error {
  constructor(
    public serverName: string,
    public serverId: string
  ) {
    super(`The connector "${serverName}" requires reconnecting (expired token): ask the user to reconnect it from the "Connect apps" view.`)
  }
}

/**
 * Esegue mcp__<server>__<tool> (e, fase app A5, composio__<toolkit>__<ACTION>).
 * Fase Composio OAuth: `timeoutMs` per le attese lunghe (WAIT_FOR_CONNECTIONS
 * può durare 5 minuti); gli strumenti NASCOSTI di Composio (C3 + K6: per
 * NOME, su qualunque server), se il modello li nomina lo stesso, si
 * rifiutano con «not available in Homun»; gli argomenti del blocco partono
 * SEMPRE con sync_response_to_workbench false (l'ultima difesa: la workbench
 * non è offerta).
 */
export async function callTool(fullName: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<string> {
  // fase app (A5): l'esecuzione passa dal modulo Composio del daemon, con la
  // STESSA versione dello schema mostrato e gli errori ripuliti
  if (fullName.startsWith('composio__')) {
    const { callComposioTool } = await import('../connectors/composio')
    return callComposioTool(fullName, args)
  }
  const parts = fullName.split('__')
  if (parts.length < 3) throw new Error(`malformed MCP tool name: ${fullName}`)
  const originalName = parts.slice(2).join('__')
  // R1: il routing per toolSlug (mcp__<toolSlug>__…): il primo server
  // abilitato col prefisso GIUSTO — mai più «il primo che slacca per nome»
  const cfg = serverOfToolName(listServers(), fullName)
  if (cfg) {
    // C3 + K6 (ritocchi): uno strumento COMPOSIO_* che non offriamo, chiamato
    // per nome dal modello lo stesso, si rifiuta su OGNI server (per nome,
    // come il gate): mai un'esecuzione nascosta
    if (!composioToolOffered(originalName)) {
      return `${originalName} is not available in Homun.`
    }
    const c = await ensure(cfg)
    const tool = c.tools.find((t) => t.def.name === fullName)
    if (!tool) throw new Error(`tool ${fullName} no longer available (reconnect)`)
    if ((connectorStateOf(cfg).disabledTools ?? []).includes(fullName)) {
      throw new Error(`tool ${fullName} disabled by the user for this connector`)
    }
    // C3: il blocco non salva la risposta nella workbench del cloud Composio
    // RW (fase revisore sulla richiesta, punto 3): la chiamata passa dal
    // wrapper col log e la ripetizione — ogni errore di trasporto finisce in
    // daemon.log (server, strumento, millisecondi, messaggio: MAI gli
    // argomenti); se era una LETTURA si riconnette e si ripete una volta da
    // sole, coperta dall'approvazione già data per QUESTA chiamata
    const attempt = async (reconnect: boolean): Promise<unknown> => {
      const cc = reconnect ? await ensure(cfg, true) : c
      const t = cc.tools.find((x) => x.def.name === fullName)
      if (!t) throw new Error(`tool ${fullName} no longer available (reconnect)`)
      if ((connectorStateOf(cfg).disabledTools ?? []).includes(fullName)) {
        throw new Error(`tool ${fullName} disabled by the user for this connector`)
      }
      const callArgs = t.originalName === COMPOSIO_MULTI_EXECUTE_TOOL
        ? forceSyncResponseToWorkbenchOff(args)
        : args
      return cc.client.callTool(
        { name: t.originalName, arguments: callArgs },
        undefined,
        opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined
      )
    }
    try {
      const res = (await callMcpWithRetry({
        server: toolSlugOf(cfg),
        tool: tool.originalName,
        isRead: mcpCallIsRead(originalName, args),
        attempt,
        // il token scaduto non si ripete: ha la sua card di riconnessione
        retryWhen: (e) => !(e instanceof UnauthorizedError)
      })) as { content?: Array<{ type: string; text?: string }> }
      const content = res.content as Array<{ type: string; text?: string }> | undefined
      const text = (content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n')
      return text || JSON.stringify(res).slice(0, 4000)
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        markNeedsAuth(cfg, uiText(UI.connTokenExpired))
        throw new McpNeedsReconnectError(cfg.name, cfg.catalogId ?? cfg.id)
      }
      throw e
    }
  }
  throw new Error(`MCP server not found for ${fullName}`)
}

export function toolNameToOriginal(fullName: string): string {
  return fullName.split('__').slice(2).join('__')
}

/**
 * Annotazioni di un tool MCP (per il gate dei permessi); undefined se non in
 * cache. Fase 6 (residuo 0a): `catalogServer` è true solo per i server
 * registrati dai connettori del catalogo (hanno catalogId, impostato da
 * wireConnectors): per loro readOnlyHint dà auto-allow, per i server manuali
 * no — l'annotazione la dichiara il server stesso e non è verificata.
 */
export function annotationsFor(
  fullName: string
): { annotations: McpAnnotations | undefined; catalogServer: boolean; serverName?: string } | undefined {
  for (const c of cache.values()) {
    const t = c.tools.find((x) => x.def.name === fullName)
    if (t) return { annotations: t.annotations, catalogServer: !!c.config.catalogId, serverName: c.config.name }
  }
  return undefined
}

// fase 5: il gate legge le annotazioni da qui (iniettato, niente import inverso)
setMcpAnnotationsLookup(annotationsFor)
