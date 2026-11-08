// Fase token (T0/T1/T2): l'UNICA fonte dell'elenco dei tool del turno. Il
// loop VERO e l'eval (T7) chiamano assembleTurnTools allo stesso modo e
// scripts/turn-tokens.ts misura ciò che il prodotto manda davvero.
//
// T1: nel turno normale restano sempre caricati solo parlare/pc/web/memory
// (facciata)/skill/find_tools; pass e post_to_group nei turni di gruppo,
// wake_parent nel figlio. Tutto il resto è nei GRUPPI. Fase token · scoperta
// (R7.2): anche la facciata document sta nel nucleo.
// T2: i gruppi sono i namespace — l'indice (id: descrizione) sta nella
// descrizione di find_tools; con {group} si attiva il gruppo esatto, con
// {query} si cercano id, descrizioni dei gruppi e nomi/descrizioni dei tool
// e si attivano i gruppi dei primi risultati (max 2). I gruppi attivati in
// conversazione (meta.activatedGroups nel transcript) entrano in CODA, in
// ordine di TOOL_GROUPS: l'elenco cresce solo in coda (cache del prefisso).
// Tutto PURO: nessuna lettura di stato, solo l'input del chiamante.
import type { ToolDef } from './llm'
import { partitionTools, useToolDef, TOOL_GROUPS, type ToolGroup } from './core-tools'
import { toolsDeferred, rankTools, findToolsGroupedDef } from '../mcp/find-tools'
import { wakeParentToolDef } from './tools'
import { buildFacadeDef, facadeCovering, FACADES } from './facades'
import type { TranscriptEntry } from '../../shared/types'

/** L'input di assembleTurnTools: i builtin del turno GIÀ filtrati (whitelist del figlio, toolsForTurnSource). */
export interface AssembleTurnToolsInput {
  /** i builtin del turno dopo le regole del turno (l'ordine è quello di toolDefs) */
  builtins: ToolDef[]
  /** il browser esiste in questo ambiente (docker + bridge): il gruppo browser si può attivare */
  browserAvailable: boolean
  /** i tool browser+computer del turno, già filtrati come i builtin (vuoti se il browser non c'è) */
  browserDefs: ToolDef[]
  /** i tool MCP del bot (server esterni → mcp__<server>__<tool>) */
  mcpToolDefs: ToolDef[]
  /** soglia connectors.maxInlineTools: sopra, i tool MCP si differiscono per server */
  maxInlineTools: number
  /** i gruppi già attivati nella conversazione (dal transcript: id di gruppo, più i nomi MCP legacy) */
  activatedGroups: string[]
  /** turno del FIGLIO: wake_parent esiste e chiude l'elenco */
  subagent?: unknown
  /** turno di GRUPPO: pass e post_to_group esistono per costruzione */
  groupTurn?: unknown
}

/** Un gruppo PRESENTE nel turno: ciò che find_tools può attivare. */
export interface ToolGroupPresent {
  id: string
  description: string
  /** i tool VERSO IL MODELLO (la facciata al posto dei tool che copre), in ordine di gruppo */
  tools: ToolDef[]
  /** i nomi INTERNI di tutti i tool del gruppo presenti (ricerca e attivazione) */
  internalNames: string[]
  /** la guida del gruppo (T4): entra nel result dell'attivazione */
  guide: string
}

/** Il risultato: l'elenco del turno, il catalogo dei gruppi e i gruppi attivi. */
export interface AssembleTurnToolsResult {
  /** l'elenco dei tool del turno, in ordine stabile (cache del prefisso) */
  tools: ToolDef[]
  /** i gruppi PRESENTI nel turno (builtin + mcp:<server> differiti): il catalogo di find_tools */
  deferredIndex: ToolGroupPresent[]
  /** i gruppi le cui definizioni sono nell'elenco (attivati + MCP inline) */
  activeGroups: string[]
}

/** T5: i budget presidiati (token stimati caratteri/4). MAI alzarli per far passare un test. */
/** Il turno base (prompt + nucleo + find_tools) del bot normale, con o senza browser.
 *  Fase token · scoperta (R7.5): 4300 — decisione dell'utente dopo l'eval (righe
 *  «quando» dei gruppi nel prompt, document nel nucleo). */
export const TURN_TOKEN_BUDGET = 4300
/** Un gruppo attivato: browser (più grande), i tre gruppi ricchi, tutti gli altri. */
export const GROUP_TOKEN_BUDGET: Record<string, number> = {
  browser: 900,
  documents: 700,
  tasks: 700,
  bots: 700
}
export const GROUP_TOKEN_BUDGET_DEFAULT = 500

/** Il gruppo MCP di un tool mcp__/composio__ ('mcp:<server>'), o null. */
export function mcpGroupOf(name: string): string | null {
  const m = /^(?:mcp|composio)__(.+?)__/.exec(name)
  return m ? `mcp:${m[1]}` : null
}

/** l'ordine stabile dei gruppi: TOOL_GROUPS prima, poi i mcp:<server> */
const groupOrder = (id: string): number => {
  const i = TOOL_GROUPS.findIndex((g) => g.id === id)
  return i >= 0 ? i : TOOL_GROUPS.length + id.localeCompare(id)
}

/**
 * I tool di un gruppo VERSO IL MODELLO (pura): la famiglia coperta da una
 * facciata (browser, document, task) diventa UN tool con campo action; gli
 * altri restano col loro nome. L'ordine è quello del gruppo in TOOL_GROUPS.
 */
function modelFacingToolsOf(group: ToolGroup, byInternal: Map<string, ToolDef>): ToolDef[] {
  const present = group.tools.filter((n) => byInternal.has(n))
  const out: ToolDef[] = []
  const doneFacades = new Set<string>()
  for (const name of present) {
    const facade = facadeCovering(name)
    if (facade) {
      if (doneFacades.has(facade)) continue
      doneFacades.add(facade)
      const internals = Object.values(FACADES[facade]!.actions)
        .map((a) => a.internal)
        .filter((n) => byInternal.has(n))
      const def = buildFacadeDef(facade, internals.map((n) => byInternal.get(n)!))
      if (def) out.push(def)
    } else {
      out.push(byInternal.get(name)!)
    }
  }
  return out
}

/** i gruppi builtin presenti nel turno (con almeno un tool nel catalogo) */
function presentBuiltinGroups(catalog: ToolDef[]): Array<{ group: ToolGroup; present: ToolGroupPresent }> {
  const byInternal = new Map(catalog.map((t) => [t.name, t]))
  const out: Array<{ group: ToolGroup; present: ToolGroupPresent }> = []
  for (const g of TOOL_GROUPS) {
    const internalNames = g.tools.filter((n) => byInternal.has(n))
    if (!internalNames.length) continue
    out.push({
      group: g,
      present: {
        id: g.id,
        description: g.description,
        tools: modelFacingToolsOf(g, byInternal),
        internalNames,
        guide: g.guide
      }
    })
  }
  return out
}

/** i gruppi mcp:<server> quando i tool MCP sono differiti (una voce per server) */
function presentMcpGroups(mcpToolDefs: ToolDef[]): ToolGroupPresent[] {
  const byServer = new Map<string, ToolDef[]>()
  for (const t of mcpToolDefs) {
    const g = mcpGroupOf(t.name)
    if (!g) continue
    byServer.set(g, [...(byServer.get(g) ?? []), t])
  }
  return [...byServer.entries()].map(([id, tools]) => ({
    id,
    description: `${tools.length} tools from the "${id.slice(4)}" connector: call find_tools({group: "${id}"}) to load them.`,
    tools,
    internalNames: tools.map((t) => t.name),
    guide: ''
  }))
}

/** L'ordine FISSO del nucleo (T1): parlare, computer, web, memory (facciata), document (facciata, R7.2), skill. */
const CORE_ORDER: ReadonlyArray<string> = [
  'send_to_user', 'message_user', 'ask_user',
  'run-command', 'read-file', 'write-file', 'list-directory',
  'web_search', 'web_fetch',
  'update_memory', 'recall_memory',
  'write_document', 'read_document', 'edit_document',
  'skill'
]

/** Le facciate del nucleo: i nomi interni che, presenti, diventano UN tool (in ordine di CORE_ORDER). */
const CORE_FACADES: ReadonlyArray<{ facade: string; internals: ReadonlyArray<string> }> = [
  { facade: 'memory', internals: ['update_memory', 'recall_memory'] },
  { facade: 'document', internals: ['write_document', 'read_document', 'edit_document'] }
]

/**
 * Fase token (T1/T2): costruisce l'elenco dei tool del turno (pura, ordine
 * stabile). Il nucleo per primo (con la facciata memory), poi find_tools con
 * l'indice dei gruppi presenti, poi i gruppi attivati in conversazione in
 * ordine di TOOL_GROUPS, poi gli MCP inline (o i gruppi mcp attivi), e
 * wake_parent per ultimo nel figlio. L'elenco cresce SOLO in coda.
 */
export function assembleTurnTools(input: AssembleTurnToolsInput): AssembleTurnToolsResult {
  const catalog = [...input.builtins, ...input.browserDefs]
  const byInternal = new Map(catalog.map((t) => [t.name, t]))
  const { core } = partitionTools(input.builtins)
  const deferredMcp = toolsDeferred(input.mcpToolDefs.length, input.maxInlineTools)

  // i gruppi presenti: builtin + (se MCP differiti) i mcp:<server>
  const builtinPresent = presentBuiltinGroups(catalog)
  const mcpPresent = deferredMcp ? presentMcpGroups(input.mcpToolDefs) : []
  const deferredIndex: ToolGroupPresent[] = [...builtinPresent.map((b) => b.present), ...mcpPresent]
  const presentById = new Map(deferredIndex.map((g) => [g.id, g]))

  // il NUCLEO, in ordine fisso: le famiglie update_memory/recall_memory e
  // write/read/edit_document diventano le facciate memory e document
  // (costruite solo coi tool presenti: nel figlio memory ha solo recall e
  // document non c'è, la whitelist non lo ammette)
  const coreDefs: ToolDef[] = []
  for (const name of CORE_ORDER) {
    const family = CORE_FACADES.find((f) => f.internals.includes(name))
    if (family) {
      if (coreDefs.some((x) => x.name === family.facade)) continue
      const internals = family.internals.filter((n) => byInternal.has(n)).map((n) => byInternal.get(n)!)
      const facade = buildFacadeDef(family.facade, internals)
      if (facade) coreDefs.push(facade)
      continue
    }
    const def = core.find((t) => t.name === name)
    if (def) coreDefs.push(def)
  }
  let allTools: ToolDef[] = [...coreDefs]
  // find_tools c'è sempre quando esiste almeno un gruppo: MAI differita, e
  // sta nel nucleo (dopo skill, prima dei tool che esistono per costruzione)
  if (deferredIndex.length > 0) {
    allTools = [...allTools, findToolsGroupedDef(deferredIndex.map((g) => `${g.id}: ${g.description}`))]
  }
  // pass e post_to_group esistono SOLO nei turni di gruppo (per costruzione)
  if (input.groupTurn !== undefined) {
    for (const name of ['post_to_group', 'pass']) {
      const def = core.find((t) => t.name === name)
      if (def) allTools.push(def)
    }
  }
  // i gruppi già attivati in conversazione: i loro tool entrano in coda, in
  // ordine di TOOL_GROUPS (stabile). Gli input possono essere id di gruppo o
  // (legacy) nomi di tool MCP già attivati: questi attivano il loro server.
  const wanted = new Set<string>()
  for (const entry of input.activatedGroups) {
    const direct = presentById.get(entry)
    if (direct) {
      wanted.add(entry)
      continue
    }
    const asTool = input.mcpToolDefs.find((t) => t.name === entry)
    const g = asTool ? mcpGroupOf(asTool.name) : null
    if (g && presentById.has(g)) wanted.add(g)
  }
  const activeGroups: string[] = []
  const ordered = [...wanted].sort((a, b) => groupOrder(a) - groupOrder(b))
  for (const id of ordered) {
    const g = presentById.get(id)!
    activeGroups.push(id)
    allTools = [...allTools, ...g.tools]
  }
  // gli MCP inline (modalità non differita) chiudono l'elenco, come sempre
  let offeredMcpDefs: ToolDef[] = []
  if (!deferredMcp && input.mcpToolDefs.length) {
    offeredMcpDefs = input.mcpToolDefs
    allTools = [...allTools, ...offeredMcpDefs]
    for (const id of new Set(offeredMcpDefs.map((t) => mcpGroupOf(t.name)).filter((g): g is string => g !== null))) {
      if (!activeGroups.includes(id)) activeGroups.push(id)
    }
  }
  // nel FIGLIO wake_parent esiste e chiude l'elenco
  if (input.subagent) allTools = [...allTools, wakeParentToolDef as ToolDef]
  return { tools: allTools, deferredIndex, activeGroups }
}

/** offerti MCP del turno (per i sendCandidates del loop): derivabile dall'elenco */
export function offeredMcpOf(tools: ToolDef[]): ToolDef[] {
  return tools.filter((t) => t.name.startsWith('mcp__') || t.name.startsWith('composio__'))
}

// ---- T2: l'attivazione dei gruppi (pura; la usano il loop e l'eval, T7) ----

/** La riga di un tool nel result dell'attivazione: nome e UNA riga di descrizione. */
function toolLine(g: ToolGroupPresent, t: ToolDef): string {
  const desc = (t.description ?? '').replace(/\s+/g, ' ').trim()
  const oneLine = desc.split(/(?<=[.!?]) /)[0] ?? desc
  return `Group ${g.id} is now active: ${t.name} — ${oneLine.slice(0, 120)}`
}

/** Il result di find_tools per i gruppi attivati: righe per tool, guida, riga finale. */
export function groupActivationText(groups: ToolGroupPresent[]): string {
  const parts: string[] = []
  for (const g of groups) {
    for (const t of g.tools) parts.push(toolLine(g, t))
    if (g.guide.trim()) parts.push(g.guide.trim())
  }
  parts.push('Call these tools directly by name from the next step.')
  return parts.join('\n')
}

/** Quanti gruppi si attivano con una query (T2). */
export const GROUPS_PER_QUERY = 2

/**
 * L'esecuzione PURA di find_tools({group}|{query}) sul catalogo del turno:
 * con group attiva il gruppo ESATTO; con query cerca su id, descrizione dei
 * gruppi e nomi/descrizioni dei tool (rankTools di oggi) e attiva i gruppi
 * dei primi risultati, al massimo GROUPS_PER_QUERY. Il testo è il result che
 * vede il modello. I gruppi già attivi si ri-attivano senza danno (idempotente).
 */
export function activateGroupsResult(
  catalog: ToolGroupPresent[],
  alreadyActive: string[],
  call: { group?: unknown; query?: unknown }
): { activated: string[]; text: string } {
  const group = typeof call.group === 'string' ? call.group.trim() : ''
  if (group) {
    const exact = catalog.find((g) => g.id === group)
    if (!exact) {
      return { activated: [], text: `No group "${group}" in this turn: the index is in the find_tools description. Try {group: "<id>"} with one of those ids, or a {query}.` }
    }
    return { activated: [exact.id], text: groupActivationText([exact]) }
  }
  const query = typeof call.query === 'string' ? call.query : ''
  if (!query.trim()) {
    return { activated: [], text: 'find_tools needs {group: "<id>"} (see the index in its description) or a {query}.' }
  }
  // la ricerca: rankTools di oggi su id+descrizione del gruppo e nomi+
  // descrizioni dei suoi tool (il testo del gruppo è la copia cercabile)
  const rankable: Array<{ id: string; name: string; description: string }> = catalog.map((g) => ({
    id: g.id,
    name: g.id,
    description: `${g.description} ${g.tools.map((t) => `${t.name}: ${t.description ?? ''}`).join(' ')}`
  }))
  // rankTools restituisce gli STESSI oggetti: si rilegge l'id del gruppo
  const ranked = rankTools(rankable, query, catalog.length).map((r) => rankable.find((x) => x === r) ?? { id: r.name }).slice(0, GROUPS_PER_QUERY)
  if (!ranked.length) {
    return { activated: [], text: 'No tool groups match this search: try other words, a group id from the index in the find_tools description, or tell the user.' }
  }
  const activated = ranked.map((r) => r.id)
  return { activated, text: groupActivationText(activated.map((id) => catalog.find((g) => g.id === id)!)) }
}

/**
 * T2, attivazione da un risultato: quando il risultato di un tool del NUCLEO
 * NOMINA un tool di un gruppo, quel gruppo si attiva (tabella pura tool →
 * gruppi candidati; conta se il testo contiene il nome di un tool del gruppo
 * come parola intera). Con un test per ogni voce.
 */
export const RESULT_ACTIVATES: Readonly<Record<string, ReadonlyArray<string>>> = {
  // il background di run-command nomina await_shell
  'run-command': ['tasks'],
  // il hint JS di web_fetch nomina browser_open
  web_fetch: ['browser']
}

/** I gruppi il cui NOME DI TOOL compare nel testo di un risultato (parola intera). */
export function groupsNamedInResult(resultText: string, catalog: ToolGroupPresent[]): string[] {
  const out: string[] = []
  for (const g of catalog) {
    const names = [...g.internalNames, ...g.tools.map((t) => t.name)]
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'u')
    if (re.test(resultText)) out.push(g.id)
  }
  return out
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * I tool VERSO IL MODELLO dei gruppi attivati, in ordine di TOOL_GROUPS: ciò
 * che il loop (e l'eval) aggiunge in CODA all'elenco del turno.
 */
export function toolDefsOfGroups(catalog: ToolGroupPresent[], ids: string[]): ToolDef[] {
  const byId = new Map(catalog.map((g) => [g.id, g]))
  return [...new Set(ids)]
    .sort((a, b) => groupOrder(a) - groupOrder(b))
    .flatMap((id) => byId.get(id)?.tools ?? [])
}

/**
 * I gruppi attivati nella CONVERSAZIONE (pura sul transcript): le entry
 * tool-result portano meta.activatedGroups con gli id; la stessa logica di
 * activeToolsFromTranscript (ultimi ACTIVE_TOOLS_MEMORY). Per continuità
 * contano anche i vecchi meta.activated coi NOMI dei tool MCP: il gruppo è
 * il loro server. Un gruppo attivato non si toglie mai.
 */
export function activeGroupsFromTranscript(
  entries: Pick<TranscriptEntry, 'kind' | 'meta'>[],
  limit = 20
): string[] {
  const ids: string[] = []
  for (const e of entries) {
    if (e.kind !== 'tool-result') continue
    const meta = e.meta as { activatedGroups?: unknown; activated?: unknown } | null
    if (Array.isArray(meta?.activatedGroups)) {
      for (const g of meta.activatedGroups) {
        if (typeof g === 'string' && g && !ids.includes(g)) ids.push(g)
      }
    }
    if (Array.isArray(meta?.activated)) {
      for (const n of meta.activated) {
        if (typeof n !== 'string') continue
        const g = mcpGroupOf(n)
        if (g && !ids.includes(g)) ids.push(g)
      }
    }
  }
  return ids.slice(-limit)
}

// use_tool non si offre più (T2) ma resta definito per le storie vecchie
export { useToolDef }
