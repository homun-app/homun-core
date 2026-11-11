// B4 (fase beta.4): il bot sa quali app ha collegate. Nel turno di Trello
// dell'utente il bot ha fatto 8 passi a vuoto (skill inesistente, memory,
// search_connectors per un connettore nuovo pur avendo Composio,
// list-credentials, cronologia): nel prompt NON c'era nessuna riga che
// dicesse quali app sono collegate. Rakazo ogni turno scrive «Connected
// plugins: … Prefer those plugin tools over the computer browser or web
// search when reading app data» (packages/adapters/src/executor.ts).
// Qui la riga si costruisce dallo stato locale del gateway Composio (le app
// collegate di C5) e dai server MCP attivi del bot; sta nella PARTE CHE
// CAMBIA del system prompt (mai nel prefisso in cache). Tutto PURO.
import type { ToolDef } from './llm'

/** Quanti nomi al massimo nella riga; poi «and N more». */
export const CONNECTED_APPS_MAX_NAMES = 20

/** I fatti della riga: le app Composio collegate e i server MCP attivi del bot. */
export interface ConnectedAppsFacts {
  /** le app collegate tramite Composio (nome umano, stato ACTIVE del gateway) */
  composioApps: string[]
  /** i server MCP attivi del bot (nome), escluso il trasporto Composio */
  mcpServers: string[]
}

/**
 * La riga del prompt (PURA, inglese come tutto il prompt): vuota senza app
 * né server. Come pluginLine di Rakazo, dice di PREFERIRE questi strumenti
 * per i dati di quelle app — non la cronologia, la memoria, il browser o un
 * connettore nuovo. Il tetto di 20 nomi vale PER LA RIGA (app + server
 * insieme, prima le app poi i server); lo sforamento si dice UNA volta,
 * in coda all'ultimo elenco di nomi.
 */
export function connectedAppsLine(facts: ConnectedAppsFacts): string {
  if (!facts.composioApps.length && !facts.mcpServers.length) return ''
  const sequence = [
    ...facts.composioApps.map((name) => ({ kind: 'app' as const, name })),
    ...facts.mcpServers.map((name) => ({ kind: 'server' as const, name }))
  ]
  const shown = sequence.slice(0, CONNECTED_APPS_MAX_NAMES)
  const over = sequence.length - shown.length
  let appsNames = shown.filter((s) => s.kind === 'app').map((s) => s.name).join(', ')
  let serversNames = shown.filter((s) => s.kind === 'server').map((s) => s.name).join(', ')
  if (over > 0) {
    const tail = `, and ${over} more`
    if (serversNames) serversNames += tail
    else appsNames += tail
  }
  const parts: string[] = []
  if (appsNames) {
    parts.push(`Connected apps: ${appsNames} (via Composio: COMPOSIO_SEARCH_TOOLS to find the action, then COMPOSIO_MULTI_EXECUTE_TOOL)`)
  }
  if (serversNames) {
    parts.push(`MCP servers: ${serversNames}`)
  }
  return `${parts.join('; ')}. To read or change these apps' data use these tools: not history, memory, the browser or a new connector.`
}

/** Un'app collegata (dal gateway Composio). */
export interface ConnectedAppRef {
  slug: string
  name: string
}

/**
 * L'app già collegata che la query di search_connectors nomina (PURA):
 * nome o slug, maiuscole irrilevanti, anche DENTRO la query («le board di
 * trello»). Null se la query non nomina nessuna app collegata.
 */
export function connectedAppMatch(query: string, connected: readonly ConnectedAppRef[]): ConnectedAppRef | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  for (const app of connected) {
    const slug = app.slug.toLowerCase()
    const name = app.name.trim().toLowerCase()
    if (!name) continue
    if (q === slug || q === name || q.includes(slug) || q.includes(name)) return app
  }
  return null
}

/**
 * I server MCP attivi del bot SENZA il trasporto Composio (le sue app sono
 * già nella riga come app collegate): si escludono i nomi che sono app del
 * gateway o server Composio. PURO rispetto agli input.
 */
export function mcpServerNames(
  servers: ReadonlyArray<{ name: string; tools: ReadonlyArray<ToolDef | { name: string }> }>,
  composioAppNames: readonly string[]
): string[] {
  const apps = new Set(composioAppNames.map((n) => n.trim().toLowerCase()))
  return servers
    .map((s) => s.name)
    .filter((name) => {
      const n = name.trim().toLowerCase()
      if (n === 'composio') return false
      return !apps.has(n)
    })
}
