// Classificazione degli invii esterni (report §3bis L5, come
// grok_bot_external_send_labeling_config): per ogni server MCP, quali tool
// inviano contenuti verso l'esterno. Una chiamata diretta del modello a uno
// di questi tool NON viene eseguita: diventa automaticamente una bozza
// (draft_external) e l'invio vero avviene solo al click dell'utente.
// Modulo PURO: la configurazione arriva da fuori, così è testabile.
//
// Correzione review fase 3 (D1): "ciò che l'utente vede è esattamente ciò che
// viene inviato". Una bozza può avere un `via` SOLO se via.tool è un invio
// esterno configurato; to/subject/body della card si leggono DA via.args
// tramite una fieldMap calcolata alla creazione; gli argomenti non mappati
// sono sempre visibili ("Altri parametri"): nessun campo nascosto.
import type { SendMessagePayload, DraftFieldMap, DraftExtraArg } from '../../shared/types'

/** server MCP (slug, come nel nome mcp__<slug>__<tool>) → nomi originali dei tool di invio */
export type ExternalSendConfig = Record<string, string[]>

export const DEFAULT_EXTERNAL_SEND_TOOLS: ExternalSendConfig = {
  gmail: ['send_message', 'reply', 'forward', 'send_email', 'send_draft'],
  slack: ['slack_send_message', 'slack_schedule_message']
}

/**
 * Annotazioni MCP standard che servono al classificatore (sottoinsieme di
 * McpAnnotations: i campi booleani che contano per gli invii).
 */
export interface SendAnnotationsLike {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  openWorldHint?: boolean
}

/**
 * Fase 0.3.1001 (M1): verbi d'invio. Un nome originale di tool è un invio se
 * COMINCIA con uno di questi verbi (segmento _) oppure se uno dei segmenti
 * SUCCESSIVI è un verbo d'invio corto (gmail_send_message, slack_send_message,
 * message_post…). Classificazione per NOME, non per elenco di server: vale
 * anche per i server aggiunti a mano.
 */
const SEND_FIRST_VERBS = new Set(['send', 'reply', 'forward', 'post', 'publish', 'share', 'invite', 'notify'])
const SEND_LATER_VERBS = new Set(['send', 'reply', 'forward', 'post'])
/** nomi che l'espressione non copre ma che sono invii (casi noti dei server). */
const SEND_EXTRA_NAMES = new Set(['send_draft', 'create_message', 'chat_postMessage'])

/** Il nome originale (segmenti _) contiene un verbo d'invio (M1). */
export function sendLikeName(original: string): boolean {
  if (SEND_EXTRA_NAMES.has(original)) return true
  const segs = original.split('_').filter(Boolean)
  if (segs.length === 0) return false
  if (SEND_FIRST_VERBS.has(segs[0]!)) return true
  return segs.slice(1).some((s) => SEND_LATER_VERBS.has(s))
}

/**
 * True se il tool (nome completo mcp__<server>__<tool>) è un invio esterno.
 * Fase 0.3.1001 (M1), classificazione per annotazioni e nome:
 * 1. elenco di cfg: sovrascrittura esplicita dell'utente (vale sempre);
 * 2. annotazioni: readOnlyHint true NON è MAI un invio (le annotazioni
 *    servono a ESCLUDERE: openWorldHint da solo non basta, molti server lo
 *    mettono anche sulle letture web);
 * 3. espressione di invio sul nome originale (sendLikeName).
 */
export function isExternalSend(tool: string, annotations: SendAnnotationsLike | undefined, cfg: ExternalSendConfig): boolean {
  const parts = tool.split('__')
  if (parts.length < 3 || parts[0] !== 'mcp') return false
  const server = parts[1]!
  const original = parts.slice(2).join('__')
  if ((cfg[server] ?? []).includes(original)) return true
  if (annotations?.readOnlyHint === true) return false
  return sendLikeName(original)
}

/** Canale della bozza dedotto dal server MCP (slug). */
export function channelForServer(serverSlug: string): 'email' | 'slack' | 'other' {
  if (serverSlug.includes('gmail') || serverSlug.includes('mail')) return 'email'
  if (serverSlug.includes('slack')) return 'slack'
  return 'other'
}

/**
 * M1: il canale di un tool, dal server e — se resta «other» — dal NOME del
 * tool (send_email su un server che non si chiama "mail" resta una email).
 */
export function channelForTool(tool: string): 'email' | 'slack' | 'other' {
  const parts = tool.split('__')
  const byServer = channelForServer(parts[1] ?? '')
  if (byServer !== 'other') return byServer
  const original = parts.slice(2).join('__')
  if (/(^|_)(e?mail)(_|$)/.test(original)) return 'email'
  return 'other'
}

/** Payload di una bozza. */
type DraftMessage = Extract<SendMessagePayload, { type: 'draft' }>

/**
 * M1: perché una bozza è senza via (riga visibile nella card, così l'utente
 * lo scopre subito e non al clic su Invia):
 * - 'no-tool': fra i tool del bot NON c'è nessun invio esterno per il canale;
 * - 'pick': c'è più di un invio per il canale, deve sceglierne il modello;
 * - 'missing-required': l'unico candidato ha proprietà required senza valore
 *   mappabile dai campi visibili (destinatario/oggetto/corpo).
 */
export type DraftSendHint = 'no-tool' | 'pick' | 'missing-required'

// Nomi di argomento comuni per destinatario/oggetto/corpo (stessi nomi e
// stesso ordine con cui draftFromExternalCall li leggeva prima della D1).
const TO_KEYS = ['to', 'recipient', 'recipients', 'email', 'user', 'channel']
const SUBJECT_KEYS = ['subject', 'title']
const BODY_KEYS = ['body', 'text', 'message', 'content']

/** Valore leggibile di un argomento: stringa non vuota o array non vuoto. */
function readableArg(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v
  if (Array.isArray(v) && v.length) return v.join(', ')
  return undefined
}

/** Primo nome di argomento (nell'ordine dei nomi comuni) con un valore leggibile. */
function mappedKey(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) if (readableArg(args[k]) !== undefined) return k
  return undefined
}

/**
 * D1: fieldMap di una bozza — quali argomenti di via.args alimentano i campi
 * visibili to/subject/body (gli stessi nomi comuni di draftFromExternalCall).
 */
export function fieldMapForArgs(args: Record<string, unknown>): DraftFieldMap {
  const fm: DraftFieldMap = {}
  const to = mappedKey(args, TO_KEYS)
  if (to) fm.to = to
  const subject = mappedKey(args, SUBJECT_KEYS)
  if (subject) fm.subject = subject
  const body = mappedKey(args, BODY_KEYS)
  if (body) fm.body = body
  return fm
}

/**
 * Residuo fase 4 (0a) + fase 5 (0c): il valore visibile che sovrascrive un
 * argomento di via.args mantiene il TIPO dell'argomento originale — se
 * l'argomento era un array (es. to: ['a@x', 'b@y']) e il modello passa la
 * stringa "a@x, b@y", viene riscritto come array (split su virgola e trim).
 * Senza questo il tool di invio riceverebbe una stringa dove si aspetta una
 * lista. Vale per la creazione (draftPayloadFromVia) e per applyDraftBody.
 */
export function coerceVisibleValue(original: unknown, value: string): unknown {
  if (Array.isArray(original)) {
    return value.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return value
}

/**
 * D1: payload di una bozza con via. I campi visibili passati dal chiamante
 * (to/subject/body del draft_external del modello) vengono scritti DENTRO
 * via.args secondo la fieldMap: c'è un'unica fonte di verità, gli argomenti
 * che verranno inviati. to/subject/body del payload si rileggono da via.args;
 * gli argomenti non mappati diventano extraArgs ("Altri parametri" della
 * card, sempre visibili). Senza un argomento per il corpo: bodyLocked
 * (modifica del testo disabilitata) e corpo di ripiego sul JSON degli argomenti.
 */
function draftPayloadFromVia(
  channel: 'email' | 'slack' | 'other',
  tool: string,
  args: Record<string, unknown>,
  visible?: { to?: string; subject?: string; body?: string }
): DraftMessage {
  const fieldMap = fieldMapForArgs(args)
  const merged = { ...args }
  if (fieldMap.to && visible?.to) merged[fieldMap.to] = coerceVisibleValue(args[fieldMap.to], visible.to)
  if (fieldMap.subject && visible?.subject) merged[fieldMap.subject] = coerceVisibleValue(args[fieldMap.subject], visible.subject)
  if (fieldMap.body && visible?.body) merged[fieldMap.body] = coerceVisibleValue(args[fieldMap.body], visible.body)
  const subject = fieldMap.subject ? readableArg(merged[fieldMap.subject]) : undefined
  const extraArgs: DraftExtraArg[] = Object.entries(merged)
    .filter(([k]) => k !== fieldMap.to && k !== fieldMap.subject && k !== fieldMap.body)
    .map(([key, v]) => ({ key, value: typeof v === 'string' ? v : JSON.stringify(v) }))
  return {
    type: 'draft',
    channel,
    to: fieldMap.to ? (readableArg(merged[fieldMap.to]) ?? '') : '',
    ...(subject !== undefined ? { subject } : {}),
    body: fieldMap.body ? (readableArg(merged[fieldMap.body]) ?? '') : JSON.stringify(merged),
    via: { tool, args: merged },
    fieldMap,
    ...(extraArgs.length ? { extraArgs } : {}),
    ...(fieldMap.body ? {} : { bodyLocked: true })
  }
}

/** D1: esito della preparazione di una bozza. */
export interface PreparedDraft {
  message: DraftMessage
  /** via.tool rifiutato (non è un invio esterno configurato): via scartato, bozza di solo testo. */
  viaRejected?: string
  /** M1: la via è stata compilata dallo schema dell'unico invio disponibile (non l'ha scelta il modello). */
  viaAuto?: boolean
  /** M1: candidati d'invio per il canale, quando il modello deve scegliere (pick) o manca tutto. */
  sendCandidates?: string[]
}

/**
 * M1: un tool MCP del bot candidato a via di una bozza: nome completo,
 * annotazioni correnti e inputSchema (i ToolDef del loop li ha già).
 */
export interface SendCandidate {
  name: string
  annotations?: SendAnnotationsLike
  parameters?: Record<string, unknown>
}

/**
 * M1: la via di una bozza senza via, dedotta dai tool del bot. Fra i tool
 * che il classificatore riconosce come invii per QUEL canale:
 * - esattamente uno → gli argomenti si mappano dal suo inputSchema con le
 *   stesse TO_KEYS/SUBJECT_KEYS/BODY_KEYS (nel verso opposto: dai campi
 *   visibili agli argomenti); se una proprietà required resta senza valore
 *   niente via (hint 'missing-required');
 * - più di uno → il modello deve scegliere (hint 'pick', candidati in lista);
 * - nessuno → hint 'no-tool'.
 * Funzione PURA: candidati e cfg arrivano da fuori.
 */
export function autoViaForChannel(
  channel: 'email' | 'slack' | 'other',
  visible: { to?: string; subject?: string; body?: string },
  candidates: SendCandidate[],
  cfg: ExternalSendConfig
): { via?: { tool: string; args: Record<string, unknown> }; hint?: DraftSendHint; candidates?: string[] } {
  const sends = candidates.filter(
    (c) => isExternalSend(c.name, c.annotations, cfg) && channelForTool(c.name) === channel
  )
  if (sends.length === 0) return { hint: 'no-tool' }
  if (sends.length > 1) return { hint: 'pick', candidates: sends.map((c) => c.name) }
  const c = sends[0]!
  const schema = c.parameters ?? {}
  const props = (schema.properties ?? {}) as Record<string, unknown>
  // nel verso opposto: per ogni nome comune, il PRIMO presente nello schema
  const schemaKey = (keys: string[]): string | undefined => {
    for (const k of keys) if (k in props) return k
    return undefined
  }
  const args: Record<string, unknown> = {}
  const toKey = schemaKey(TO_KEYS)
  if (toKey && visible.to) args[toKey] = valueForSchema(props[toKey], visible.to)
  const subjectKey = schemaKey(SUBJECT_KEYS)
  if (subjectKey && visible.subject) args[subjectKey] = valueForSchema(props[subjectKey], visible.subject)
  const bodyKey = schemaKey(BODY_KEYS)
  if (bodyKey && visible.body) args[bodyKey] = valueForSchema(props[bodyKey], visible.body)
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === 'string') : []
  const missing = required.filter((k) => {
    const v = args[k]
    return v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  })
  if (missing.length) return { hint: 'missing-required', candidates: [c.name] }
  return { via: { tool: c.name, args } }
}

/** Il valore visibile (stringa) nel tipo che lo schema dichiara (array → split). */
function valueForSchema(propSchema: unknown, value: string): unknown {
  if (propSchema && typeof propSchema === 'object' && (propSchema as { type?: unknown }).type === 'array') {
    return value.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return value
}

/**
 * D1: prepara il payload di un draft_external del modello. Il via è tenuto
 * SOLO se via.tool è un invio esterno secondo il classificatore (M1:
 * annotazioni + nome, cfg come sovrascrittura); altrimenti viene scartato
 * (bozza di solo testo) e viaRejected lo riporta per la tool-result al
 * modello. M1: senza via del modello, si prova a compilarla dai tool del
 * bot (autoViaForChannel) — la bozza "conosce sempre il suo via" o dice
 * perché non può averne uno (sendHint, riga visibile nella card).
 */
export function prepareDraft(input: {
  channel: 'email' | 'slack' | 'other'
  to?: string
  subject?: string
  body?: string
  via?: unknown
  cfg: ExternalSendConfig
  /** M1: annotazioni correnti del tool indicato in via (lette dal chiamante) */
  viaAnnotations?: SendAnnotationsLike
  /** M1: i tool MCP del bot (nome, annotazioni, schema) per compilare la via in automatico */
  candidates?: SendCandidate[]
}): PreparedDraft {
  const textOnly: DraftMessage = {
    type: 'draft', channel: input.channel,
    to: input.to ?? '', ...(input.subject !== undefined ? { subject: input.subject } : {}),
    body: input.body ?? ''
  }
  const v = input.via as { tool?: unknown; args?: unknown } | undefined
  if (!v || typeof v !== 'object') {
    // M1: nessun via del modello → via automatica dai tool del bot
    if (input.candidates?.length) {
      const auto = autoViaForChannel(input.channel, { to: input.to, subject: input.subject, body: input.body }, input.candidates, input.cfg)
      if (auto.via) {
        return {
          message: draftPayloadFromVia(input.channel, auto.via.tool, auto.via.args, {
            to: input.to, subject: input.subject, body: input.body
          }),
          viaAuto: true
        }
      }
      return { message: { ...textOnly, ...(auto.hint ? { sendHint: auto.hint } : {}) }, sendCandidates: auto.candidates }
    }
    return { message: textOnly }
  }
  const tool = typeof v.tool === 'string' && v.tool ? v.tool : ''
  const args = v.args && typeof v.args === 'object' && !Array.isArray(v.args)
    ? { ...(v.args as Record<string, unknown>) }
    : undefined
  if (!tool || !args || !isExternalSend(tool, input.viaAnnotations, input.cfg)) {
    return { message: textOnly, viaRejected: tool || 'invalid via' }
  }
  return {
    message: draftPayloadFromVia(input.channel, tool, args, {
      to: input.to, subject: input.subject, body: input.body
    })
  }
}

/**
 * D1 + residuo fase 5 (0c): aggiorna il corpo di una bozza in modo coerente —
 * il testo visibile (message.body) E l'argomento di via.args che verrà davvero
 * inviato (fieldMap.body; se la bozza non ha fieldMap, cioè è stata salvata
 * prima della correzione, la ricalcola dagli argomenti), mantenendo il TIPO
 * dell'argomento originale. Senza un argomento mappato sul corpo tocca solo
 * il testo visibile.
 */
export function applyDraftBody(message: DraftMessage, body: string): void {
  message.body = body
  if (!message.via) return
  const fieldMap = message.fieldMap ?? fieldMapForArgs(message.via.args)
  if (fieldMap.body) {
    message.via = {
      ...message.via,
      args: { ...message.via.args, [fieldMap.body]: coerceVisibleValue(message.via.args[fieldMap.body], body) }
    }
  }
}

/**
 * Costruisce il payload della bozza da una chiamata esterna intercettata:
 * destinatario/oggetto/corpo letti dagli argomenti tramite la fieldMap (nomi
 * comuni: to/recipient/recipients, subject/title, body/text/message/content),
 * corpo di ripiego sul JSON degli argomenti, argomenti non mappati sempre
 * visibili in extraArgs. Il canale arriva dal server.
 */
export function draftFromExternalCall(
  tool: string,
  args: Record<string, unknown>
): DraftMessage {
  // M1: il canale arriva dal server e, se resta «other», dal nome del tool
  return draftPayloadFromVia(channelForTool(tool), tool, args)
}
