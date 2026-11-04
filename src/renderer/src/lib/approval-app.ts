// R3 (fase app — ritocchi): il modello PURO della card d'approvazione per
// gli strumenti Composio e MCP. In chat l'utente non vede mai nomi tecnici
// (composio__…, mcp__…): il motivo diventa una frase umana («Vuole fare
// questa azione su Slack.») e il nome tecnico vive solo dentro il
// «Dettagli tecnici» chiuso, insieme a server/toolkit e versione.
//
// Fase Composio OAuth (C7 punto 1): il modello del BLOCCO — titolo dalle
// azioni («Gmail · Invia email, Slack · Invia messaggio», con «…» se una
// voce non ha nome), per ogni azione gli argomenti BREVI prima e i testi
// lunghi dopo (argumentLines di Rakazo), l'account quando c'è.
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

/** Un'azione del blocco nel meta.composioBatch (argomenti già ripuliti dal daemon). */
export interface ComposioBatchActionMeta {
  slug: string
  app: string
  action: string
  kind: 'read' | 'send' | 'write' | 'destructive' | 'connect'
  arguments: Record<string, unknown>
  account?: string
}

/** Il meta.composioBatch scritto dal loop (gate C2/C3/C5). */
export interface ComposioBatchMeta {
  actions: ComposioBatchActionMeta[]
  incomplete: boolean
  destructive: boolean
  noAlways: boolean
  reason: 'action' | 'incomplete' | 'trust' | 'rule'
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
  /** fase Composio OAuth: il blocco (o le connessioni/proxy) con le sue azioni */
  batch?: ComposioBatchMeta
}

/** Che card è? Composio (meta.composioAction o nome composio__), MCP (mcp__), altro (null). */
export function approvalAppOf(tool: string, meta: Record<string, unknown> | null | undefined): ApprovalAppInfo | null {
  const composioAction = (meta as { composioAction?: ComposioActionMeta } | null | undefined)?.composioAction
  const batch = (meta as { composioBatch?: ComposioBatchMeta } | null | undefined)?.composioBatch
  if (batch || composioAction || tool.startsWith('composio__')) {
    return {
      kind: 'composio',
      app: (composioAction?.app || tool.split('__')[1] || '').trim(),
      action: composioAction?.action,
      slug: composioAction?.slug ?? (tool.startsWith('composio__') ? tool : undefined),
      version: composioAction?.version,
      original: composioAction?.original,
      destructive:
        (meta as { composioDestructive?: boolean } | null | undefined)?.composioDestructive === true,
      ...(batch ? { batch } : {})
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

/**
 * Il titolo del BLOCCO (C7 punto 1): un'azione «Gmail · Invia email», più
 * azioni «Gmail · Invia email, Slack · Invia messaggio», con «…» se una voce
 * non ha nome. Il nome dell'azione si ri-localizza dallo slug quando cambia
 * lingua (come approvalActionName).
 */
export function approvalBatchTitle(info: ApprovalAppInfo, uiLang: UiLanguage): string {
  const batch = info.batch
  if (!batch) return ''
  const names = batch.actions.map((a) => {
    const action = uiLang === 'it'
      ? localizedActionName(a.slug, 'it') ?? a.action
      : a.action
    return action ? `${a.app} · ${action}` : a.app
  })
  return [...names, ...(batch.incomplete ? ['…'] : [])].join(', ')
}

/** Il titolo umano della card per Composio e MCP (null → il titolo generico di askTitle). */
export function approvalTitleOf(
  info: ApprovalAppInfo | null,
  agentName: string,
  uiLang: UiLanguage
): string | MessageDescriptor | null {
  if (!info) return null
  if (info.kind === 'composio') {
    if (info.batch) return approvalBatchTitle(info, uiLang)
    const action = approvalActionName(info, uiLang)
    return action ? `${info.app} · ${action}` : info.app
  }
  return msg`${agentName} vuole usare uno strumento di ${info.app}`
}

/** La frase umana del motivo per Composio e MCP (scrittura o distruttiva). */
export function approvalReasonPhrase(info: ApprovalAppInfo): MessageDescriptor | null {
  // fase Composio OAuth (C7): per il blocco la frase nomina le APP delle azioni.
  // V9 (prova vera): per il blocco NON distruttivo niente frase generica qui —
  // vince il testo del catalogo UI (approval.composioBatch) col plurale giusto
  // e il CONTEGGIO: «Vuole fare 1 azione su Gmail» / «2 azioni su Gmail e Slack»
  if (info.batch) {
    const apps = [...new Set(info.batch.actions.map((a) => a.app))].filter(Boolean).join(', ') || 'Composio'
    if (info.destructive) return msg`Vuole fare azioni che non si possono annullare su ${apps}.`
    return null
  }
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

// ---- il blocco: le righe degli argomenti per azione (C7 punto 1) ----

/** Più lungo di così è un «testo lungo»: va DOPO i valori brevi (argumentLines di Rakazo). */
export const BATCH_SHORT_ARGUMENT_LENGTH = 200

/** Le righe brevi e i testi lunghi degli argomenti di un'azione del blocco. */
export function approvalBatchArgumentLines(args: Record<string, unknown>): { first: Array<[string, string]>; last: Array<[string, string]> } {
  const first: Array<[string, string]> = []
  const last: Array<[string, string]> = []
  for (const [key, raw] of Object.entries(args)) {
    const text = batchArgumentText(raw)
    if (!text) continue
    const line: [string, string] = [key, text]
    if (text.length <= BATCH_SHORT_ARGUMENT_LENGTH) first.push(line)
    else last.push(line)
  }
  return { first, last }
}

function batchArgumentText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object')) {
    return value.map(String).join(', ')
  }
  return JSON.stringify(value) ?? ''
}
