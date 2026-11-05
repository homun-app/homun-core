// Fase mcp-setup ritocchi (R1): lo slug degli strumenti di un server MCP.
// Modulo LEGGERO e senza dipendenze (lo importano le migrazioni e l'install):
// l'identificatore stabile dei tool (mcp__<toolSlug>__…) è UNA COSA sola con
// l'etichetta umana (cfg.name) che può cambiare — il titolo del registro
// arriva alla prima connessione riuscita — senza che cambino i nomi degli
// strumenti, le regole di permesso e i disabledTools, che stanno per nome
// completo.
import type { McpServerConfig } from './index'

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * R1: il prefisso degli strumenti di un server — `cfg.toolSlug` se c'è
 * (deciso all'installazione e mai più cambiato), altrimenti slug del nome
 * (i server del catalogo, il cui nome non cambia mai). È L'UNICO punto da
 * leggere per costruire o confrontare un prefisso `mcp__…`.
 */
export function toolSlugOf(cfg: Pick<McpServerConfig, 'toolSlug' | 'name'>): string {
  return cfg.toolSlug ?? slug(cfg.name)
}

/** Il tetto dei provider: mcp__<slug>__<tool> deve stare nei 64 caratteri. */
export const TOOL_SLUG_MAX = 24

/**
 * R1 (puro): il toolSlug di un server NUOVO — slug del titolo, TAGLIATO a 24
 * caratteri; se un altro server lo usa già (contano anche i server del
 * catalogo e il riservato «composio»), si aggiunge -2, -3… sempre entro i 24.
 */
export function assignToolSlug(name: string, existing: Array<Pick<McpServerConfig, 'toolSlug' | 'name'>>): string {
  const taken = new Set<string>(['composio'])
  for (const s of existing) taken.add(toolSlugOf(s))
  const base = slug(name).slice(0, TOOL_SLUG_MAX) || 'server'
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const suffix = `-${i}`
    const candidate = `${base.slice(0, TOOL_SLUG_MAX - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * R1 (puro): il toolSlug di un server che sta per essere (RI)salvato — quello
 * che HA GIÀ (una reinstallazione/aggiornamento non lo cambia mai: permessi e
 * disabledTools restano validi), altrimenti uno nuovo libero tra gli ALTRI.
 */
export function toolSlugKeeping(
  existing: Array<Pick<McpServerConfig, 'id' | 'toolSlug' | 'name'>>,
  id: string,
  name: string
): string {
  const mine = existing.find((s) => s.id === id)
  if (mine?.toolSlug) return mine.toolSlug
  return assignToolSlug(name, existing.filter((s) => s.id !== id))
}

/**
 * R1 (puro): il server a cui appartiene un nome completo mcp__<slug>__<tool>
 * — il routing di callTool. La parte PURA della scelta (il primo server
 * abilitato col toolSlug GIUSTO), così la collisione del catalogo Notion +
 * registro «Notion» si prova senza server veri.
 */
export function serverOfToolName(servers: McpServerConfig[], fullName: string): McpServerConfig | undefined {
  const parts = fullName.split('__')
  if (parts.length < 3 || parts[0] !== 'mcp') return undefined
  const serverSlug = parts[1]!
  return servers.find((cfg) => cfg.enabled && toolSlugOf(cfg) === serverSlug)
}
