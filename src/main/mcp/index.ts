// Client MCP — i server MCP (stdio o HTTP) diventano tool dinamici dell'agente,
// con nomi mcp__<server>__<tool> come i tool esterni dell'originale (discover-ai-tool).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { getSetting, setSetting } from '../store/db'
import type { ToolDef } from '../agent/llm'

export interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string   // stdio
  args?: string[]    // stdio
  url?: string       // http
  enabled: boolean
}

const CACHE_TTL = 5 * 60_000
interface Cached { client: Client; tools: McpToolInfo[]; at: number; config: McpServerConfig }
const cache = new Map<string, Cached>()

export interface McpToolInfo {
  serverId: string
  serverName: string
  originalName: string
  def: ToolDef
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

async function connect(cfg: McpServerConfig): Promise<Client> {
  const client = new Client({ name: 'sandbot', version: '0.1.0' })
  if (cfg.transport === 'stdio') {
    await client.connect(new StdioClientTransport({ command: cfg.command ?? '', args: cfg.args ?? [] }))
  } else {
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url ?? 'http://localhost')))
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
    }
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
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Tutti i tool MCP abilitati, pronti per il loop agente. Riconnette se scaduti. */
export async function activeTools(): Promise<ToolDef[]> {
  const out: ToolDef[] = []
  for (const cfg of listServers().filter((s) => s.enabled)) {
    try {
      const c = await ensure(cfg)
      out.push(...c.tools.map((t) => t.def))
    } catch {
      // server non raggiungibile: lo saltiamo senza rompere il turno
    }
  }
  return out
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
    const res = await c.client.callTool({ name: tool.originalName, arguments: args })
    const content = res.content as Array<{ type: string; text?: string }> | undefined
    const text = (content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n')
    return text || JSON.stringify(res).slice(0, 4000)
  }
  throw new Error(`server MCP non trovato per ${fullName}`)
}

export function toolNameToOriginal(fullName: string): string {
  return fullName.split('__').slice(2).join('__')
}
