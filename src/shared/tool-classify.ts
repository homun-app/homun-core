// PL2 (fase plugin): la divisione degli strumenti di un plugin in SOLA
// LETTURA / SCRITTURA / ALTRO e l'insieme FISSO (invii, pagamenti) che non
// offre mai «Consenti sempre» — modulo PURO condiviso (renderer e nodo).
// Le regole della fase: le annotazioni MCP readOnlyHint/destructiveHint
// quando ci sono, il classificatore Composio per composio__<tk>__<ACTION>,
// altrimenti «Altro». I pattern e i verbi sono COPIA dei classificatori veri
// (main/connectors/composio-actions.ts e main/agent/external-send.ts, che
// non si possono importare nel renderer per node:crypto): il test incrociato
// src/shared/__tests__/tool-classify.test.ts li inchioda — se uno cambia,
// diventa rosso.
export type ToolGroup = 'read' | 'write' | 'other'

export const TOOL_GROUP_OTHER: ToolGroup = 'other'

/** Il tipo dell'insieme fisso: invii verso fuori, pagamenti/acquisti. */
export type FixedAskKind = 'send' | 'payment'

/** Le annotazioni MCP che contano per la divisione (sottoinsieme standard). */
export interface ToolAnnotationsLike {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  openWorldHint?: boolean
}

// ---- i pattern Composio (copia di composio-actions.ts, vedi il test incrociato) ----

const MUTATING_PATTERN =
  /(^|[_-])(accept|add|approve|archive|assign|buy|cancel|charge|checkout|close|commit|copy|create|delete|deploy|disable|enable|execute|forward|grant|invite|link|mark|merge|modify|move|patch|pay|post|publish|purchase|put|register|reject|remove|rename|replace|reply|reset|revoke|run|schedule|send|set|share|start|stop|submit|subscribe|trigger|unassign|unlink|unsubscribe|update|upload|upsert|write)([_-]|$)/i

const READ_PATTERN =
  /(^|[_-])(get|list|search|find|read|fetch|retrieve|query|view|describe|show|lookup|count)([_-]|$)/i

const COMPOUND_PATTERN = /[_-](and|or|then)[_-]/i

const DESTRUCTIVE_PATTERN =
  /(^|[_-])(delete|remove|cancel|revoke|archive|purge|destroy|erase|wipe|unlink|terminate|trash|abandon|detach|drop|clear)([_-]|$)/i

// ---- i verbi degli invii (copia di external-send.ts / composio-actions.ts) ----

const SEND_FIRST_VERBS = new Set(['send', 'reply', 'forward', 'post', 'publish', 'share', 'invite', 'notify'])
const SEND_LATER_VERBS = new Set(['send', 'reply', 'forward', 'post'])
const READ_FIRST_VERBS = new Set([
  'get', 'read', 'list', 'search', 'fetch', 'find', 'query', 'describe', 'view', 'show',
  'retrieve', 'lookup', 'count'
])
const SEND_EXTRA_NAMES = new Set(['send_draft', 'create_message', 'chat_postmessage'])

/** Le parole (IT/EN) di PAGAMENTO e ACQUISTO (copia di squad-autonomy.ts). */
const PAYMENT_WORDS = [
  'paga', 'pago', 'pagare', 'pagamento', 'acquista', 'acquisto', 'acquistare',
  'compra', 'compro', 'prenota', 'prenoto', 'prenotare', 'ordina', 'ordino',
  'procedi al pagamento', 'paga ora', 'conferma ordine',
  'pay', 'buy', 'purchase', 'checkout', 'place order', 'subscribe'
] as const

/** I segmenti di un nome (camelCase e separatori → parole piccole). */
function segmentsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase())
}

/** Il nome originale (senza prefissi) descrive un invio verso l'esterno? */
export function sendLikeSegments(original: string): boolean {
  const name = original.trim().toLowerCase()
  if (!name) return false
  if (SEND_EXTRA_NAMES.has(name)) return true
  const segs = segmentsOf(name)
  if (segs.length === 0) return false
  // verbo di lettura in testa: «post»/«reply» più avanti sono di solito nomi,
  // ma «send»/«forward» restano verbi (fetch_and_send): fail closed
  if (READ_FIRST_VERBS.has(segs[0]!)) return segs.slice(1).some((s) => s === 'send' || s === 'forward')
  if (SEND_FIRST_VERBS.has(segs[0]!)) return true
  return segs.slice(1).some((s) => SEND_LATER_VERBS.has(s))
}

/** La parte dopo i prefissi noti del toolkit di un'azione Composio. */
function stripToolkitPrefixOf(toolkit: string, action: string): string {
  const prefix = `${toolkit.toUpperCase()}_`
  return action.toUpperCase().startsWith(prefix) ? action.slice(prefix.length) : action
}

/** Il nome di uno strumento contiene una parola di pagamento/acquisto (parola intera)? */
export function isPaymentToolName(name: string): boolean {
  // le frasi di più parole («place order», «paga ora») si confrontano sul
  // nome ricostruito a parole, come matchesWholeWord della squadra
  const text = ` ${segmentsOf(name).join(' ')} `
  return (PAYMENT_WORDS as readonly string[]).some((w) => text.includes(` ${w} `))
}

/**
 * L'insieme FISSO di uno strumento: invii (send/reply/forward…) e
 * pagamenti/acquisti — mai «Consenti sempre». readOnlyHint ESCLUDE l'invio
 * (la stessa regola del classificatore delle bozze). La Cassaforte e i
 * login sono strumenti di Homun, non di un plugin: qui non compaiono.
 */
export function fixedAskOf(full: string, annotations?: ToolAnnotationsLike): FixedAskKind | null {
  if (annotations?.readOnlyHint === true) return null
  const parts = full.split('__')
  const original = parts.length >= 3 ? parts.slice(2).join('__') : full
  if (parts[0] === 'composio') {
    return sendLikeSegments(original) ? 'send' : isPaymentToolName(original) ? 'payment' : null
  }
  if (sendLikeSegments(original)) return 'send'
  return isPaymentToolName(original) ? 'payment' : null
}

/**
 * La divisione di uno strumento (PL2): annotazioni quando ci sono, poi il
 * classificatore Composio per composio__, altrimenti «Altro». Il gruppo non
 * è un verdetto: è solo dove lo strumento si mostra nella scheda.
 */
export function classifyPluginTool(full: string, annotations?: ToolAnnotationsLike): { group: ToolGroup; fixedAsk: FixedAskKind | null } {
  const parts = full.split('__')
  let group: ToolGroup = TOOL_GROUP_OTHER
  if (parts[0] === 'composio' && parts.length >= 3) {
    // il classificatore delle azioni (copia allineata dal test incrociato)
    const bare = stripToolkitPrefixOf(parts[1]!, parts.slice(2).join('__'))
    if (COMPOUND_PATTERN.test(bare) || MUTATING_PATTERN.test(bare)) group = 'write'
    else group = READ_PATTERN.test(bare) ? 'read' : 'write'
  } else if (annotations?.readOnlyHint === true) {
    group = 'read'
  } else if (annotations?.destructiveHint === true) {
    group = 'write'
  }
  return { group, fixedAsk: fixedAskOf(full, annotations) }
}
