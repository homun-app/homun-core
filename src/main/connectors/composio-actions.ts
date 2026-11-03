// Fase app (A6): la classificazione delle azioni di Composio, PURA. Le azioni
// dell'API diretta («GMAIL_SEND_EMAIL») entrano nella STESSA pipeline degli
// strumenti MCP, ma il nome va classificato SENZA il prefisso del toolkit
// (GMAIL_): altrimenti il primo segmento sarebbe il nome dell'app e le regole
// «verbo in testa» non funzionerebbero.
//
// La regola di lettura è quella di Rakazo (packages/core/src/action-approval.ts
// 79–113): un'azione è «di sola lettura» solo se il nome ha un verbo di
// lettura E nessun verbo di modifica E nessuna azione composta. Una
// dichiarazione «read» del fornitore NON allenta MAI il controllo sul nome
// (non passiamo readOnly dichiarati a questo classificatore).
// Modulo puro: nessuna dipendenza dal daemon, testabile in nodo puro.
import { createHash } from 'node:crypto'

/** Il prefisso degli strumenti Composio nella pipeline (come mcp__ per i server). */
export const COMPOSIO_TOOL_PREFIX = 'composio__'

/**
 * Il pattern di modifica COMPLETO di Rakazo (action-approval.ts:81): un verbo
 * di modifica come SEGMENTO del nome (confine _ o inizio/fine). Portato per
 * intero, con test: accorciarlo lascerebbe passare scritture (es. «write»).
 */
export const MUTATING_COMPOSIO_ACTION_PATTERN =
  /(^|[_-])(accept|add|approve|archive|assign|buy|cancel|charge|checkout|close|commit|copy|create|delete|deploy|disable|enable|execute|forward|grant|invite|link|mark|merge|modify|move|patch|pay|post|publish|purchase|put|register|reject|remove|rename|replace|reply|reset|revoke|run|schedule|send|set|share|start|stop|submit|subscribe|trigger|unassign|unlink|unsubscribe|update|upload|upsert|write)([_-]|$)/i

/** Verbi di lettura (Rakazo action-approval.ts:79): get|list|search|find|read come segmento. */
export const READ_COMPOSIO_ACTION_PATTERN = /(^|[_-])(get|list|search|find|read)([_-]|$)/i

/** Azioni composte (_and_ / _or_ / _then_): mai lettura, sempre card. */
export const COMPOUND_COMPOSIO_ACTION_PATTERN = /[_-](and|or|then)[_-]/i

/**
 * A6 (punto 4): i verbi DISTRUTTIVI — card SENZA «Consenti sempre», come le
 * installazioni. Oltre a delete/remove/cancel/revoke/archive/purge: i verbi
 * che distruggono o rendono irreversibile.
 */
export const DESTRUCTIVE_COMPOSIO_ACTION_PATTERN =
  /(^|[_-])(delete|remove|cancel|revoke|archive|purge|destroy|erase|wipe|unlink|terminate|trash|abandon|detach|drop|clear)([_-]|$)/i

/** I modi dell'A6: lettura senza card, invio in bozza, scrittura con card, distruttivo senza «sempre». */
export type ComposioActionKind = 'read' | 'send' | 'write' | 'destructive'

/** Il prefisso del toolkit da togliare: GMAIL_SEND_EMAIL → SEND_EMAIL (A6 punto 1). */
export function stripToolkitPrefix(toolkitSlug: string, actionSlug: string): string {
  const prefix = `${toolkitSlug.trim().toUpperCase()}_`
  const upper = actionSlug.trim().toUpperCase()
  return upper.startsWith(prefix) ? actionSlug.slice(prefix.length) : actionSlug
}

/**
 * Verifica fase app: i nomi accorciati (oltre COMPOSIO_TOOL_NAME_MAX) perdono
 * la coda dell'azione, dove possono stare «_AND_DELETE…». composioToolName
 * ricorda qui il nome completo, così la classificazione lavora sempre sullo
 * slug intero; un nome accorciato che non si trova qui è «truncated» e non
 * passa mai per lettura (fail closed).
 */
const fullActionOfShortName = new Map<string, string>()
const SHORTENED_NAME = /_[0-9a-f]{6}$/

/** Il nome dell'azione SENZA prefisso del toolkit, dal nome COMPLETO dello strumento. */
export function composioActionOfToolName(toolName: string): { toolkit: string; action: string; truncated?: boolean } | null {
  if (!toolName.startsWith(COMPOSIO_TOOL_PREFIX)) return null
  const rest = toolName.slice(COMPOSIO_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  const toolkit = rest.slice(0, sep)
  const full = fullActionOfShortName.get(toolName)
  const action = full ?? rest.slice(sep + 2)
  if (!toolkit || !action) return null
  const truncated = full === undefined && toolName.length === COMPOSIO_TOOL_NAME_MAX && SHORTENED_NAME.test(toolName)
  return { toolkit, action: stripToolkitPrefix(toolkit, action), ...(truncated ? { truncated: true } : {}) }
}

/**
 * A6: il modo di un'azione dal nome SENZA prefisso del toolkit (la funzione la
 * toglie lei: passa il nome completo dello strumento o l'action slug nudo).
 * - lettura: verbo di lettura E nessun verbo di modifica E nessuna composta;
 * - invio: riconosciuto dal classificatore degli invii sul nome senza
 *   prefisso (SEND_EMAIL, SEND_MESSAGE…);
 * - distruttivo: pattern di modifica con verbo distruttivo;
 * - scrittura: tutto il resto.
 */
export function classifyComposioAction(name: string): ComposioActionKind {
  const stripped = composioActionOfToolName(name)
  const bare = stripped ? stripped.action : name
  // nome accorciato senza lo slug completo: la coda persa può essere una
  // modifica, quindi mai «lettura»
  if (stripped?.truncated) return DESTRUCTIVE_COMPOSIO_ACTION_PATTERN.test(bare) ? 'destructive' : 'write'
  if (COMPOUND_COMPOSIO_ACTION_PATTERN.test(bare)) {
    // composta: contiene _and_/_or_/_then_ → sempre card (e distruttiva se
    // dentro c'è anche un verbo distruttivo)
    return DESTRUCTIVE_COMPOSIO_ACTION_PATTERN.test(bare) ? 'destructive' : 'write'
  }
  const mutating = MUTATING_COMPOSIO_ACTION_PATTERN.test(bare)
  if (mutating) {
    return DESTRUCTIVE_COMPOSIO_ACTION_PATTERN.test(bare) ? 'destructive' : 'write'
  }
  return READ_COMPOSIO_ACTION_PATTERN.test(bare) ? 'read' : 'write'
}

/**
 * A6 (punto 3): il nome senza prefisso è un INVIO? Stesso classificatore delle
 * bozze (isExternalSend usa sendLikeName sul nome originale): qui si riusa la
 * stessa lista di verbi, duplicata per non creare il collegamento inverso
 * (external-send.ts non importa moduli del daemon). FAIL CLOSED: invio in
 * testa vince sempre; un verbo di lettura in testa lascia invio solo a
 * send/forward (fetch_and_send).
 */
const SEND_FIRST_VERBS = new Set(['send', 'reply', 'forward', 'post', 'publish', 'share', 'invite', 'notify'])
const SEND_LATER_VERBS = new Set(['send', 'reply', 'forward', 'post'])
const READ_FIRST_VERBS = new Set(['get', 'read', 'list', 'search', 'fetch', 'find', 'query', 'describe', 'view', 'show'])
const SEND_EXTRA_NAMES = new Set(['send_draft', 'create_message', 'chat_postmessage'])

function segments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase())
}

/** Il nome (senza prefisso del toolkit) descrive un invio verso l'esterno? */
export function composioSendLikeName(name: string): boolean {
  const bare = composioActionOfToolName(name)
  const original = (bare ? bare.action : name).trim()
  if (!original) return false
  if (SEND_EXTRA_NAMES.has(original.toLowerCase())) return true
  const segs = segments(original)
  if (segs.length === 0) return false
  if (READ_FIRST_VERBS.has(segs[0]!)) return segs.slice(1).some((s) => s === 'send' || s === 'forward')
  if (SEND_FIRST_VERBS.has(segs[0]!)) return true
  return segs.slice(1).some((s) => SEND_LATER_VERBS.has(s))
}

/** Il modo COMPLETO di uno strumento Composio dal nome completo (composio__tk__ACTION). */
export function classifyComposioToolName(toolName: string): ComposioActionKind {
  if (composioSendLikeName(toolName)) {
    // l'invio è una bozza a monte del gate; se però è ANCHE distruttivo
    // (send_and_delete…: composta) la bozza non basta, conta il più severo
    const kind = classifyComposioAction(toolName)
    return kind === 'destructive' ? 'destructive' : 'send'
  }
  return classifyComposioAction(toolName)
}

// ---- i nomi degli strumenti (A5) ----

/** Il limite dei nomi funzione verso i provider (il più stretto: OpenAI 64). */
export const COMPOSIO_TOOL_NAME_MAX = 64

/**
 * Il nome dello strumento: composio__<toolkit>__<ACTION_SLUG> (per esempio
 * composio__gmail__GMAIL_SEND_EMAIL). Oltre il limite dei provider si accorcia
 * l'azione e si appende un hash corto: la mappa nome ↔ slug sta nel daemon
 * (registryTools di composio.ts, ricostruita dagli schemi scaricati).
 */
export function composioToolName(toolkitSlug: string, actionSlug: string): string {
  const toolkit = toolkitSlug.trim().toLowerCase()
  const action = actionSlug.trim().toUpperCase()
  const full = `${COMPOSIO_TOOL_PREFIX}${toolkit}__${action}`
  if (full.length <= COMPOSIO_TOOL_NAME_MAX) return full
  const hash = createHash('sha256').update(action).digest('hex').slice(0, 6)
  const head = `${COMPOSIO_TOOL_PREFIX}${toolkit}__`
  const room = COMPOSIO_TOOL_NAME_MAX - head.length - hash.length - 1
  const short = `${head}${action.slice(0, Math.max(1, room))}_${hash}`
  fullActionOfShortName.set(short, action)
  return short
}

/** Lo slug reso leggibile: SEND_EMAIL → «Send email» (ripiego senza nome umano). */
export function readableActionSlug(actionSlug: string): string {
  const stripped = composioActionOfToolName(actionSlug)
  const bare = stripped ? stripped.action : actionSlug
  const words = bare
    .toLowerCase()
    .split(/[_\-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  return words.join(' ')
}

// ---- la pulizia degli errori (A5, regex di sanitizeComposioError di Rakazo) ----

/** I prefissi delle chiavi Composio e dei token noti: mai nel testo che esce. */
const SECRET_LITERAL_PATTERNS: Array<[RegExp, string]> = [
  [/ak_[A-Za-z0-9]+/g, '[redacted]'],
  [/ck_[A-Za-z0-9]+/g, '[redacted]'],
  [/uak_[A-Za-z0-9]+/g, '[redacted]'],
  [/oak_[A-Za-z0-9]+/g, '[redacted]'],
  [/sk-or-v1-[A-Za-z0-9]+/g, '[redacted]'],
  [/Bearer\s+\S+/gi, 'Bearer [redacted]']
]

/** I nomi di campo credenziale (assegnazioni chiave=valore nei testi d'errore). */
const CREDENTIAL_FIELD_NAME =
  'composio[_-]?api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|api[_-]?key|password|passwd|secret'

const CREDENTIAL_ASSIGNMENT = new RegExp(
  `(["']?\\b(?:${CREDENTIAL_FIELD_NAME})\\b["']?\\s*[=:]\\s*)` +
    `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,&;}]+(?:;(?![A-Za-z0-9_]+[=:])[^\\s,&;}]+)*)`,
  'gi'
)

/** Toglie i valori dei segreti da un testo (chiavi ak_…, Bearer, assegnazioni). */
export function redactComposioSecrets(text: string): string {
  let out = text.replace(CREDENTIAL_ASSIGNMENT, '$1"[redacted]"')
  for (const [pattern, replacement] of SECRET_LITERAL_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** L'errore di Composio ripulito: nessuna chiave, nessun Bearer, nessun token nel testo. */
export function sanitizeComposioError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactComposioSecrets(message)
}

// ---- le provenienze (A7) ----

/** La riga piccola sulla provenienza, come chiave i18n del catalogo UI. */
export type ComposioProvenance = 'direct' | 'composio'
