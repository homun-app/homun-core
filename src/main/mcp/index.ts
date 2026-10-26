// Client MCP — i server MCP (stdio o HTTP) diventano tool dinamici dell'agente,
// con nomi mcp__<server>__<tool> come i tool esterni dell'originale (discover-ai-tool).
//
// Fase 5: i server HTTP possono autenticarsi con OAuth (OAuthClientProvider,
// connettori del catalogo) o con header statici/bearer salvati CIFRATI nello
// store dei connettori (mai nei settings in chiaro). Le annotazioni standard
// dei tool (readOnlyHint/destructiveHint/openWorldHint) alimentano il gate dei
// permessi (permissions.ts); i tool disattivati per connettore non vengono
// offerti al modello; un token scaduto manda il connettore in 'needs_auth'.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { getSetting, setSetting } from '../store/db'
import { setMcpAnnotationsLookup } from '../agent/permissions'
import type { ToolDef } from '../agent/llm'

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
}
export type McpAuthResolver = (cfg: McpServerConfig) => McpAuth | Promise<McpAuth>
let authResolver: McpAuthResolver = () => ({})

/** Registra il resolver d'autenticazione (il daemon lo collega ai connettori). */
export function setMcpAuthResolver(fn: McpAuthResolver): void {
  authResolver = fn
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
  const status = connectorStateOf(cfg).status
  return status === 'needs_auth' || status === 'error'
}

/** Token scaduto/rifiutato: il connettore va riconnesso dall'utente. */
function markNeedsAuth(cfg: McpServerConfig, message: string): void {
  const id = cfg.catalogId ?? cfg.id
  if (!cfg.catalogId) return // server manuale senza stato connettore: niente da segnare
  const all = getSetting<Record<string, Record<string, unknown>>>('connectors.state', {})
  const cur = (all[id] ?? {}) as Record<string, unknown>
  setSetting('connectors.state', { ...all, [id]: { ...cur, status: 'needs_auth', error: message } })
}

async function connect(cfg: McpServerConfig): Promise<Client> {
  const client = new Client({ name: 'sandbot', version: '0.1.0' })
  if (cfg.transport === 'stdio') {
    await client.connect(new StdioClientTransport({ command: cfg.command ?? '', args: cfg.args ?? [] }))
  } else {
    const a = await authResolver(cfg)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(cfg.url ?? 'http://localhost'), {
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
  const client = await connect(cfg)
  const res = await client.listTools()
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
  if (!cfg) return { ok: false, error: 'server non trovato' }
  try {
    const c = await ensure(cfg, true)
    return { ok: true, tools: c.tools.map((t) => t.def.name) }
  } catch (e) {
    if (e instanceof UnauthorizedError) markNeedsAuth(cfg, 'token scaduto: riconnetti')
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Tool completi di un server (nome, descrizione, annotazioni) per la UI "Connetti app". */
export async function toolsOfServer(id: string): Promise<
  Array<{ name: string; description: string; annotations?: McpAnnotations }>
> {
  const cfg = listServers().find((s) => s.id === id)
  if (!cfg) throw new Error('server non trovato')
  const c = await ensure(cfg, true)
  return c.tools.map((t) => ({
    name: t.def.name,
    description: t.def.description,
    ...(t.annotations ? { annotations: t.annotations } : {})
  }))
}

/** Tutti i tool MCP abilitati, pronti per il loop agente. Riconnette se scaduti. */
export async function activeTools(): Promise<ToolDef[]> {
  const out: ToolDef[] = []
  for (const cfg of listServers().filter((s) => s.enabled && !skippedByConnectorState(s))) {
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

/** Errore di un tool MCP che richiede la riconnessione del connettore (card "Riconnetti"). */
export class McpNeedsReconnectError extends Error {
  constructor(
    public serverName: string,
    public serverId: string
  ) {
    super(`Il connettore "${serverName}" richiede la riconnessione (token scaduto): chiedi all'utente di riconnetterlo dalla vista "Connetti app".`)
  }
}

/** Esegue mcp__<server>__<tool>. */
export async function callTool(fullName: string, args: Record<string, unknown>): Promise<string> {
  const parts = fullName.split('__')
  if (parts.length < 3) throw new Error(`nome tool MCP malformato: ${fullName}`)
  const serverSlug = parts[1]
  for (const cfg of listServers().filter((s) => s.enabled)) {
    if (slug(cfg.name) !== serverSlug) continue
    const c = await ensure(cfg)
    const tool = c.tools.find((t) => t.def.name === fullName)
    if (!tool) throw new Error(`tool ${fullName} non più disponibile (riconnetti)`)
    if ((connectorStateOf(cfg).disabledTools ?? []).includes(fullName)) {
      throw new Error(`tool ${fullName} disattivato dall'utente per questo connettore`)
    }
    try {
      const res = await c.client.callTool({ name: tool.originalName, arguments: args })
      const content = res.content as Array<{ type: string; text?: string }> | undefined
      const text = (content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n')
      return text || JSON.stringify(res).slice(0, 4000)
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        markNeedsAuth(cfg, 'token scaduto: riconnetti')
        throw new McpNeedsReconnectError(cfg.name, cfg.catalogId ?? cfg.id)
      }
      throw e
    }
  }
  throw new Error(`server MCP non trovato per ${fullName}`)
}

export function toolNameToOriginal(fullName: string): string {
  return fullName.split('__').slice(2).join('__')
}

/** Annotazioni di un tool MCP (per il gate dei permessi); undefined se non in cache. */
export function annotationsFor(fullName: string): McpAnnotations | undefined {
  for (const c of cache.values()) {
    const t = c.tools.find((x) => x.def.name === fullName)
    if (t) return t.annotations
  }
  return undefined
}

// fase 5: il gate legge le annotazioni da qui (iniettato, niente import inverso)
setMcpAnnotationsLookup(annotationsFor)
