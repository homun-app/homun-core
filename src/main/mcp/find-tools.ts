// Tool deferiti (fase 13, punto 5): quando i tool MCP abilitati per un bot
// superano connectors.maxInlineTools (default 30), NESSUNO schema MCP va nel
// prompt — al loro posto la sezione "Connettori attivi" e il tool find_tools,
// che attiva i tool che servono (come il tool search di Anthropic con
// defer_loading e i meta-tool dei gateway: non tutti gli schemi nel prompt).
// Tutto PURO: BM25 semplice su nome/descrizione/parametri, pareggio in ordine
// alfabetico, gli attivati si ricostruiscono dal TRANSCRIPT (niente stato nuovo).
import type { ToolDef } from '../agent/llm'
import type { TranscriptEntry } from '../../shared/types'

/** Soglia di default dei tool MCP inline nel prompt. */
export const DEFAULT_MAX_INLINE_TOOLS = 30

/** Quanti tool find_tools restituisce (e attiva). */
export const FIND_TOOLS_LIMIT = 8

/** Quanti tool attivati restano attivi nei turni successivi (dal transcript). */
export const ACTIVE_TOOLS_MEMORY = 20

/** La descrizione del server nella sezione "Connettori attivi": 80 caratteri. */
export const SERVER_DESC_CHARS = 80

/** I token di una stringa: minuscoli, parole alfanumeriche (puro). */
function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? []).filter((t) => t.length > 1 || /\d/.test(t))
}

export interface RankableTool {
  name: string
  description?: string
  /** nomi dei parametri obbligatori (contano nel punteggio) */
  requiredParams?: string[]
}

/**
 * rankTools(tools, query) (pura): BM25 semplice — token minuscoli della query
 * contro nome (peso 3), nomi dei parametri (peso 2) e descrizione (peso 1);
 * idf = log(1 + N/df); a parità di punteggio vince l'ordine alfabetico.
 * La query vuota restituisce i primi 8 in ordine alfabetico.
 */
export function rankTools(tools: RankableTool[], query: string, limit = FIND_TOOLS_LIMIT): RankableTool[] {
  const q = tokens(query)
  const fields = tools.map((t) => ({
    t,
    name: tokens(t.name),
    params: tokens((t.requiredParams ?? []).join(' ')),
    desc: tokens(t.description ?? '')
  }))
  const df = new Map<string, number>()
  for (const f of fields) {
    const seen = new Set([...f.name, ...f.params, ...f.desc])
    for (const tok of seen) df.set(tok, (df.get(tok) ?? 0) + 1)
  }
  const n = fields.length || 1
  const scored = fields.map((f) => {
    let score = 0
    for (const tok of q) {
      const idf = Math.log(1 + n / (1 + (df.get(tok) ?? 0)))
      const tf = 3 * f.name.filter((x) => x === tok).length + 2 * f.params.filter((x) => x === tok).length + f.desc.filter((x) => x === tok).length
      if (tf > 0) score += idf * (tf / (tf + 2))
    }
    return { t: f.t, score }
  })
  // con una query i punteggi a ZERO non si restituiscono: find_tools attiva
  // solo ciò che MATCHA (altrimenti attiverebbe tutto il catalogo)
  const onlyMatching = q.length > 0
  return scored
    .filter((x) => (onlyMatching ? x.score > 0 : true))
    .sort((a, b) => (b.score - a.score) || a.t.name.localeCompare(b.t.name))
    .slice(0, limit)
    .map((x) => x.t)
}

/** I nomi dei parametri obbligatori di uno schema JSON (puro, best-effort). */
export function requiredParamsOf(def: ToolDef): string[] {
  const schema = def.parameters as { required?: unknown } | undefined
  return Array.isArray(schema?.required) ? schema.required.map(String) : []
}

/** Il result di find_tools: nome completo, descrizione (200 caratteri), parametri obbligatori (puro). */
export function formatFindToolsResult(found: Array<{ name: string; description?: string; requiredParams?: string[] }>): string {
  if (!found.length) return 'Nessuno strumento MCP trovato con questa ricerca: riprova con altre parole o dillo all\'utente.'
  return found
    .map((t) => {
      const desc = (t.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      const req = t.requiredParams?.length ? ` · parametri obbligatori: ${t.requiredParams.join(', ')}` : ''
      return `- ${t.name}: ${desc}${req}`
    })
    .join('\n')
}

/**
 * I tool MCP attivati con find_tools nella CONVERSAZIONE (pura sul
 * transcript): le entry tool-result dei find_tools portano meta.activated
 * coi nomi attivati; si tengono gli ULTIMI 20 (ordine di attivazione, senza
 * duplicati). È la persistenza richiesta: niente stato nuovo.
 */
export function activeToolsFromTranscript(entries: Pick<TranscriptEntry, 'kind' | 'meta'>[], limit = ACTIVE_TOOLS_MEMORY): string[] {
  const names: string[] = []
  for (const e of entries) {
    const activated = (e.meta as { activated?: unknown } | null)?.activated
    if (e.kind === 'tool-result' && Array.isArray(activated)) {
      for (const n of activated) {
        if (typeof n === 'string' && !names.includes(n)) names.push(n)
      }
    }
  }
  return names.slice(-limit)
}

/** La sezione del prompt "Connettori attivi" (pura): una riga per server. */
export function connectorsActiveSection(servers: Array<{ name: string; toolCount: number; description?: string }>): string {
  if (!servers.length) return ''
  const lines = servers.map((s) => {
    const desc = (s.description ?? '').replace(/\s+/g, ' ').trim().slice(0, SERVER_DESC_CHARS)
    return `- ${s.name}: ${s.toolCount} strumenti${desc ? ` — ${desc}` : ''}`
  })
  return [
    '# Connettori attivi',
    `I loro strumenti NON sono elencati qui: cercali con find_tools({query}) quando ti servono e chiamali dal passo dopo. Server attivi:`,
    ...lines
  ].join('\n')
}

/** La definizione del tool find_tools (aggiunta dal loop SOLO in modalità differita). */
export const findToolsToolDef: ToolDef = {
  name: 'find_tools',
  description: 'Cerca fra gli strumenti MCP dei connettori attivi (server collegati, plugin, gateway) e ATTIVA fino a 8 strumenti: dal passo successivo puoi chiamarli per nome. Usalo prima di dire che non puoi fare qualcosa.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Parole chiave dello strumento che cerchi (es. "issue linear crea")' }
    },
    required: ['query']
  }
}

/** Oltre la soglia i tool MCP vanno deferiti? (pura) */
export function toolsDeferred(total: number, maxInlineTools: number): boolean {
  return total > maxInlineTools
}
