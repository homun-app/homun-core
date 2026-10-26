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
 * True se il tool (nome completo mcp__<server>__<tool>) è un invio esterno
 * secondo la configurazione: server slug presente in config e nome originale
 * nella sua lista.
 */
export function isExternalSend(tool: string, cfg: ExternalSendConfig): boolean {
  const parts = tool.split('__')
  if (parts.length < 3) return false
  const server = parts[1]!
  const original = parts.slice(2).join('__')
  return (cfg[server] ?? []).includes(original)
}

/** Canale della bozza dedotto dal server MCP (slug). */
export function channelForServer(serverSlug: string): 'email' | 'slack' | 'other' {
  if (serverSlug.includes('gmail') || serverSlug.includes('mail')) return 'email'
  if (serverSlug.includes('slack')) return 'slack'
  return 'other'
}

/** Payload di una bozza. */
type DraftMessage = Extract<SendMessagePayload, { type: 'draft' }>

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
}

/**
 * D1: prepara il payload di un draft_external del modello. Il via è tenuto
 * SOLO se via.tool è un invio esterno secondo la configurazione; altrimenti
 * viene scartato (bozza di solo testo) e viaRejected lo riporta per la
 * tool-result al modello.
 */
export function prepareDraft(input: {
  channel: 'email' | 'slack' | 'other'
  to?: string
  subject?: string
  body?: string
  via?: unknown
  cfg: ExternalSendConfig
}): PreparedDraft {
  const textOnly: DraftMessage = {
    type: 'draft', channel: input.channel,
    to: input.to ?? '', ...(input.subject !== undefined ? { subject: input.subject } : {}),
    body: input.body ?? ''
  }
  const v = input.via as { tool?: unknown; args?: unknown } | undefined
  if (!v || typeof v !== 'object') return { message: textOnly }
  const tool = typeof v.tool === 'string' && v.tool ? v.tool : ''
  const args = v.args && typeof v.args === 'object' && !Array.isArray(v.args)
    ? { ...(v.args as Record<string, unknown>) }
    : undefined
  if (!tool || !args || !isExternalSend(tool, input.cfg)) {
    return { message: textOnly, viaRejected: tool || 'via non valido' }
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
  const server = tool.split('__')[1] ?? ''
  return draftPayloadFromVia(channelForServer(server), tool, args)
}
