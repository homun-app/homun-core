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
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { getSetting, setSetting } from '../store/db'
import { setMcpAnnotationsLookup } from '../agent/permissions'
import { dockerStdioMcpArgv } from '../sandbox/docker-argv'
import { boxOwnerOf, ensureBoxContainer, ensureBotHome } from '../sandbox'
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
  /** fase 13: installato ma in attesa di valori che l'utente inserisce nelle Impostazioni */
  needsAuth?: { kind: 'key' | 'env' | 'settings'; keys: string[] }
  /** fase 13: fiducia mostrata nella scheda Installati (dominio verificato, …) */
  trustLabel?: string
  /** fase 17c (C5): il kind della fiducia — la UI lo traduce */
  trustKind?: 'verified-domain' | 'github-account' | 'unverified'
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
  return dockerStdioMcpArgv({ ...box, envKeys })
}

export function listServers(): McpServerConfig[] {
  return getSetting<McpServerConfig[]>('mcp.servers', [])
}

export function saveServers(s: McpServerConfig[]): void {
  setSetting('mcp.servers', s)
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
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

async function connect(cfg: McpServerConfig): Promise<Client> {
  const client = new Client({ name: 'sandbot', version: '0.1.0' })
  if (cfg.transport === 'stdio') {
    if (cfg.box) {
      // fase 13: server stdio di registro/plugin — gira NEL BOX (docker exec),
      // mai sul Mac; le env col solo NOME in argv, i valori nell'env del figlio.
      // L4: il box esiste PRIMA dell'exec (container, poi home, poi exec — la
      // stessa catena di execDocker), altrimenti su un daemon nuovo l'errore è
      // "No such container" mascherato da "Connection closed"
      const owner = boxOwnerOfWorkdir(cfg.box)
      await boxEnsure.ensureBox()
      if (owner) await boxEnsure.ensureHome(boxOwnerOf(owner))
      const a = await authResolver(cfg)
      const argv = boxStdioArgv(cfg, a.stdioEnv)
      await client.connect(
        a.stdioEnv && Object.keys(a.stdioEnv).length
          ? new StdioClientTransport({ command: 'docker', args: argv, env: { ...process.env, ...a.stdioEnv } as Record<string, string> })
          : new StdioClientTransport({ command: 'docker', args: argv })
      )
      return client
    }
    await client.connect(new StdioClientTransport({ command: cfg.command ?? '', args: cfg.args ?? [] }))
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
  const tools: McpToolInfo[] = (res.tools ?? []).map((t) => ({
    serverId: cfg.id,
    serverName: cfg.name,
    originalName: t.name,
    def: {
      name: `mcp__${slug(cfg.name)}__${t.name}`,
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
  return out
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

/** Esegue mcp__<server>__<tool>. */
export async function callTool(fullName: string, args: Record<string, unknown>): Promise<string> {
  const parts = fullName.split('__')
  if (parts.length < 3) throw new Error(`malformed MCP tool name: ${fullName}`)
  const serverSlug = parts[1]
  for (const cfg of listServers().filter((s) => s.enabled)) {
    if (slug(cfg.name) !== serverSlug) continue
    const c = await ensure(cfg)
    const tool = c.tools.find((t) => t.def.name === fullName)
    if (!tool) throw new Error(`tool ${fullName} no longer available (reconnect)`)
    if ((connectorStateOf(cfg).disabledTools ?? []).includes(fullName)) {
      throw new Error(`tool ${fullName} disabled by the user for this connector`)
    }
    try {
      const res = await c.client.callTool({ name: tool.originalName, arguments: args })
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
): { annotations: McpAnnotations | undefined; catalogServer: boolean } | undefined {
  for (const c of cache.values()) {
    const t = c.tools.find((x) => x.def.name === fullName)
    if (t) return { annotations: t.annotations, catalogServer: !!c.config.catalogId }
  }
  return undefined
}

// fase 5: il gate legge le annotazioni da qui (iniettato, niente import inverso)
setMcpAnnotationsLookup(annotationsFor)
