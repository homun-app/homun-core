// Classificazione degli invii esterni (report §3bis L5, come
// grok_bot_external_send_labeling_config): per ogni server MCP, quali tool
// inviano contenuti verso l'esterno. Una chiamata diretta del modello a uno
// di questi tool NON viene eseguita: diventa automaticamente una bozza
// (draft_external) e l'invio vero avviene solo al click dell'utente.
// Modulo PURO: la configurazione arriva da fuori, così è testabile.
import type { SendMessagePayload } from '../../shared/types'

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

/**
 * Costruisce il payload della bozza da una chiamata esterna intercettata:
 * destinatario/oggetto/corpo su best-effort dai nomi di argomento più comuni
 * (to/recipient/recipients, subject/title, body/text/message/content), corpo
 * di ripiego sul JSON degli argomenti. Il canale arriva dal server.
 */
export function draftFromExternalCall(
  tool: string,
  args: Record<string, unknown>
): Extract<SendMessagePayload, { type: 'draft' }> {
  const server = tool.split('__')[1] ?? ''
  const first = (keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = args[k]
      if (typeof v === 'string' && v.trim()) return v
      if (Array.isArray(v) && v.length) return v.join(', ')
    }
    return undefined
  }
  const subject = first(['subject', 'title'])
  return {
    type: 'draft',
    channel: channelForServer(server),
    to: first(['to', 'recipient', 'recipients', 'email', 'user', 'channel']) ?? '',
    ...(subject !== undefined ? { subject } : {}),
    body: first(['body', 'text', 'message', 'content']) ?? JSON.stringify(args),
    via: { tool, args }
  }
}
