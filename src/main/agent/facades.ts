// Fase token (T3): le FACCIATE verso il modello — una famiglia di azioni
// simili diventa UN tool con campo `action` (come il tool computer di
// Anthropic). Quattro facciate: browser (11 azioni → browser_*), document
// (write/read/edit → *_document), task (create/update → *_task), memory
// (save/recall/delete → update_memory/recall_memory). Lo schema della
// facciata è l'UNIONE dei parametri dei tool interni, tutti facoltativi
// tranne action (enum); la descrizione di ogni parametro porta tra parentesi
// le azioni che lo usano. Lo srotolamento (expandFacadeCall) è PURO e il loop
// lo applica UNA volta, nello stesso punto dello srotolamento di use_tool e
// PRIMA di coerceToolArgs, permessi, gate e card: da lì in poi tutto vede il
// nome interno; nei messages verso il modello la chiamata resta come scritta.
//
// update_memory e browser_tabs hanno una loro `action` interna: la facciata
// la ricava (memory save → write/update dall'id, delete → delete; browser
// tabs → il parametro `tab`), così il nome `action` resta della sola
// facciata. I nomi INTERNI non cambiano: permessi, regole, card e giudici
// dell'eval continuano a vedere browser_click, write_document, update_memory…
import type { ToolDef } from './llm'
import { requiredParamsOf } from '../mcp/find-tools'

/** Una azione della facciata: il tool interno e la riga di descrizione (≤ 60 caratteri). */
export interface FacadeAction {
  internal: string
  line: string
  /**
   * I parametri richiesti da QUESTA azione, quando lo schema del tool interno
   * non li sa esprimere (update_memory richiede content/tier per write ma
   * solo id per delete: la facciata li dichiara per azione).
   */
  required?: string[]
}

/** La spec di una facciata: nome, azioni in ordine, riga di descrizione per azione. */
export interface FacadeSpec {
  name: string
  /** azione → tool interno */
  actions: Record<string, FacadeAction>
  /**
   * Fase token · scoperta (R7.2/R7.3): la regola che SOLO la descrizione può
   * dare (nessun errore la fa rispettare), in testa alle righe delle azioni.
   */
  rule?: string
}

export const FACADES: Record<string, FacadeSpec> = {
  browser: {
    name: 'browser',
    actions: {
      open: { internal: 'browser_open', line: 'open a URL and read the page' },
      snapshot: { internal: 'browser_snapshot', line: 're-read the page as text with refs' },
      click: { internal: 'browser_click', line: 'click an element by ref' },
      type: { internal: 'browser_type', line: 'type text into a field by ref' },
      select: { internal: 'browser_select', line: 'choose dropdown options by ref' },
      press_key: { internal: 'browser_press_key', line: 'press a key or combo' },
      wait: { internal: 'browser_wait', line: 'wait for a text or some seconds' },
      tabs: { internal: 'browser_tabs', line: 'new/select/close a tab' },
      back: { internal: 'browser_back', line: 'go back one page' },
      close: { internal: 'browser_close', line: 'close the page' },
      screenshot: { internal: 'browser_screenshot', line: 'screenshot of the page' }
    }
  },
  document: {
    name: 'document',
    // R7.2: document è nel NUCLEO; il testo lungo va qui, in chat un messaggio breve
    rule: 'Reports, notes, plans and anything longer than a short reply go here, not in chat; then send a short message.',
    actions: {
      write: { internal: 'write_document', line: 'write a new document (markdown)' },
      read: { internal: 'read_document', line: 'read a saved document' },
      edit: { internal: 'edit_document', line: 'replace exact text in a document' }
    }
  },
  task: {
    name: 'task',
    actions: {
      create: { internal: 'create_task', line: 'open a long-work thread' },
      update: { internal: 'update_task', line: 'update/close the task' }
    }
  },
  memory: {
    name: 'memory',
    actions: {
      save: { internal: 'update_memory', line: 'save a fact or rule (write/update)', required: ['content', 'tier'] },
      recall: { internal: 'recall_memory', line: 'search your memories' },
      delete: { internal: 'update_memory', line: 'delete a memory by id', required: ['id'] }
    }
  }
}

/** nome facciata → spec (le quattro facciate della fase) */
export const FACADE_ACTIONS: Map<string, FacadeSpec> = new Map(Object.values(FACADES).map((f) => [f.name, f]))

/** le facciate indicizzate per nome (browser, document, task, memory) */
export const FACADE_DEFS: Record<string, FacadeSpec> = FACADES

/** il tool interno coperto da una facciata, o null (più facciate non condividono tool) */
export function facadeCovering(internalName: string): string | null {
  for (const f of Object.values(FACADES)) {
    if (Object.values(f.actions).some((a) => a.internal === internalName)) return f.name
  }
  return null
}

/** come il loop (e l'eval, T7) fornisce gli schemi interni allo srotolamento */
export type InternalSchemaOf = (internalName: string) => Pick<ToolDef, 'name' | 'parameters'> | null

/** i parametri (nome → schema, required) di un tool interno (puro, best-effort) */
function paramsOf(def: Pick<ToolDef, 'parameters'>): { properties: Record<string, Record<string, unknown>>; required: string[] } {
  const schema = def.parameters as { properties?: unknown; required?: unknown } | null
  const properties = schema?.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, Record<string, unknown>>
    : {}
  const required = Array.isArray(schema?.required) ? schema.required.map(String) : []
  return { properties, required }
}

/**
 * Lo schema della facciata a partire dai tool interni PRESENTI nel turno
 * (pura): unione dei parametri — meno l'`action` interna del tool, che la
 * facciata ricava — tutti facoltativi tranne action (enum delle azioni i cui
 * tool ci sono). Nella descrizione di ogni parametro, tra parentesi, le
 * azioni che lo usano; la descrizione della facciata è una riga per azione
 * (R7.2: preceduta dalla regola della facciata, quando c'è — document).
 */
export function buildFacadeDef(facadeName: string, internalDefs: ReadonlyArray<ToolDef>): ToolDef | null {
  const spec = FACADE_ACTIONS.get(facadeName)
  if (!spec) return null
  const byInternal = new Map(internalDefs.map((t) => [t.name, t]))
  const actions = Object.entries(spec.actions).filter(([, a]) => byInternal.has(a.internal))
  if (!actions.length) return null
  // unione dei parametri: nome → { schema, actions[] }, in ordine di prima apparizione
  const union = new Map<string, { schema: Record<string, unknown>; actions: string[] }>()
  for (const [action, a] of actions) {
    const def = byInternal.get(a.internal)!
    const { properties } = paramsOf(def)
    for (const [p, schema] of Object.entries(properties)) {
      if (p === 'action') continue // l'action interna la ricava la facciata
      const seen = union.get(p)
      if (seen) seen.actions.push(action)
      else union.set(p, { schema: { ...schema }, actions: [action] })
    }
  }
  const properties: Record<string, unknown> = {
    action: {
      type: 'string',
      enum: actions.map(([a]) => a),
      description: `The action to run (one line per action in the tool description)`
    }
  }
  for (const [p, { schema, actions: used }] of union) {
    const base = typeof schema.description === 'string' ? schema.description.replace(/\s+$/, '') : ''
    properties[p] = { ...schema, description: `${base}${base ? ' ' : ''}(${used.join(', ')})`.trim() }
  }
  return {
    name: spec.name,
    description: [...(spec.rule ? [spec.rule] : []), ...actions.map(([a, x]) => `${a}: ${x.line}`)].join('\n'),
    parameters: { type: 'object', properties, required: ['action'] }
  }
}

export type ExpandResult =
  | { ok: true; name: string; arguments: string }
  | { ok: false; error: string }

/**
 * Lo srotolamento (puro): {name, arguments} della facciata → il nome interno
 * e i parametri per quel tool. Errori brevi (azione mancante o sconosciuta,
 * parametro richiesto mancante) con le azioni valide e i parametri di
 * quell'azione: il loop li restituisce al modello SENZA eseguire niente.
 * Un nome che non è facciata passa invariato (il loop la chiama per ogni call).
 */
export function expandFacadeCall(call: { name: string; arguments: string }, schemaOf: InternalSchemaOf): ExpandResult {
  const spec = FACADE_ACTIONS.get(call.name)
  if (!spec) return { ok: true, name: call.name, arguments: call.arguments }
  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(call.arguments || '{}')
    args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    args = {}
  }
  const validActions = Object.entries(spec.actions)
    .filter(([, a]) => schemaOf(a.internal) !== null)
  const action = typeof args.action === 'string' ? args.action : ''
  const validList = validActions.map(([a]) => a).join(', ')
  if (!action) {
    return { ok: false, error: `${spec.name} requires action: one of ${validList}.` }
  }
  const entry = validActions.find(([a]) => a === action)
  if (!entry) {
    return { ok: false, error: `Unknown action "${action}" for ${spec.name}: valid actions are ${validList}.` }
  }
  const internal = entry[1].internal
  const def = schemaOf(internal)
  if (!def) return { ok: false, error: `${internal} is not available in this turn.` }
  const rest: Record<string, unknown> = { ...args }
  delete rest.action
  // browser tabs: il parametro `tab` diventa l'action interna di browser_tabs
  if (spec.name === 'browser' && action === 'tabs' && rest.tab !== undefined) {
    rest.action = rest.tab
    delete rest.tab
  }
  // memory save/delete: l'action interna di update_memory (write/update/delete)
  if (spec.name === 'memory' && internal === 'update_memory') {
    rest.action = action === 'save' ? (rest.id !== undefined ? 'update' : 'write') : action
  }
  const required = entry[1].required ?? (def.parameters ? requiredParamsOf(def as ToolDef) : [])
  const missing = required.filter((p) => rest[p] === undefined)
  if (missing.length) {
    return { ok: false, error: `${spec.name} action "${action}" (${internal}) requires: ${missing.join(', ')}.` }
  }
  return { ok: true, name: internal, arguments: JSON.stringify(rest) }
}
