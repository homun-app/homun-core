// R3 (fase app — ritocchi): il modello PURO della card d'approvazione per
// gli strumenti Composio e MCP. In chat l'utente non vede mai nomi tecnici
// (composio__…, mcp__…): il motivo diventa una frase umana («Vuole fare
// questa azione su Slack.») e il nome tecnico vive solo dentro il
// «Dettagli tecnici» chiuso, insieme a server/toolkit e versione.
//
// I test usano questo modello come snapshot (come opening-rows): ciò che la
// card mostra FUORI dai dettagli non contiene mai i prefissi tecnici.
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { UiLanguage } from '../../../shared/ui-language'
import { localizedActionName } from '../../../shared/composio-names'

/** Il meta.composioAction scritto dal loop (R4: con slug, versione e nome originale). */
export interface ComposioActionMeta {
  app?: string
  action?: string
  slug?: string
  version?: string
  /** il nome ORIGINALE di Composio («Create reminder»): in inglese vince lui */
  original?: string
}

/** I dati umani di uno strumento Composio o MCP (null per gli altri tool). */
export interface ApprovalAppInfo {
  kind: 'composio' | 'mcp'
  /** il nome umano del toolkit o del server */
  app: string
  /** il nome dell'azione (localizzato quando possibile, dai dati della card) */
  action?: string
  /** lo slug dell'azione Composio (per ri-localizzare quando cambia lingua) */
  slug?: string
  /** la versione dello schema Composio */
  version?: string
  /** il nome ORIGINALE di Composio («Create reminder») */
  original?: string
  /** azione che non si può annullare (niente «Consenti sempre») */
  destructive: boolean
}

/** Che card è? Composio (meta.composioAction o nome composio__), MCP (mcp__), altro (null). */
export function approvalAppOf(tool: string, meta: Record<string, unknown> | null | undefined): ApprovalAppInfo | null {
  const composioAction = (meta as { composioAction?: ComposioActionMeta } | null | undefined)?.composioAction
  if (composioAction || tool.startsWith('composio__')) {
    return {
      kind: 'composio',
      app: (composioAction?.app || tool.split('__')[1] || '').trim(),
      action: composioAction?.action,
      slug: composioAction?.slug ?? (tool.startsWith('composio__') ? tool : undefined),
      version: composioAction?.version,
      original: composioAction?.original,
      destructive: (meta as { composioDestructive?: boolean } | null | undefined)?.composioDestructive === true
    }
  }
  if (tool.startsWith('mcp__')) {
    return {
      kind: 'mcp',
      app: (typeof (meta as { mcpApp?: unknown } | null | undefined)?.mcpApp === 'string'
        ? (meta as { mcpApp: string }).mcpApp
        : tool.split('__')[1] ?? '').trim(),
      destructive: (meta as { mcpDestructive?: boolean } | null | undefined)?.mcpDestructive === true
    }
  }
  return null
}

/** Il nome dell'azione nella lingua attiva (R4): localizzato PER INTERO in
 *  italiano, il nome ORIGINALE di Composio in inglese (mai la traduzione
 *  salvata a un'altra lingua). */
export function approvalActionName(info: ApprovalAppInfo, uiLang: UiLanguage): string {
  if (info.kind !== 'composio') return ''
  if (uiLang === 'it') return localizedActionName(info.slug ?? '', 'it') ?? info.action ?? info.original ?? ''
  return info.original ?? info.action ?? localizedActionName(info.slug ?? '', 'it') ?? ''
}

/** Il titolo umano della card per Composio e MCP (null → il titolo generico di askTitle). */
export function approvalTitleOf(
  info: ApprovalAppInfo | null,
  agentName: string,
  uiLang: UiLanguage
): string | MessageDescriptor | null {
  if (!info) return null
  if (info.kind === 'composio') {
    const action = approvalActionName(info, uiLang)
    return action ? `${info.app} · ${action}` : info.app
  }
  return msg`${agentName} vuole usare uno strumento di ${info.app}`
}

/** La frase umana del motivo per Composio e MCP (scrittura o distruttiva). */
export function approvalReasonPhrase(info: ApprovalAppInfo): MessageDescriptor {
  return info.destructive
    ? msg`Vuole fare un'azione che non si può annullare su ${info.app}.`
    : msg`Vuole fare questa azione su ${info.app}.`
}

/** La riga DEI DETTAGLI TECHNICI (chiusi): nome tecnico + server/toolkit + versione. */
export function approvalTechnicalLine(info: ApprovalAppInfo, tool: string): string {
  if (info.kind === 'composio') {
    const parts = ['Composio', info.app || tool.split('__')[1] || '', ...(info.version ? [`versione ${info.version}`] : [])]
    return `${tool}\n${parts.filter(Boolean).join(' · ')}`
  }
  return `${tool}\nserver ${info.app}`
}
