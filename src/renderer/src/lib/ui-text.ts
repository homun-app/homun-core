// Fase 17c (C1): il testo della UI di una entry del transcript. Le entry
// scritte dalla 17c portano meta.ui = {id, values} (o una LISTA di UiText,
// per i motivi multipli di run-command): si traducono col catalogo del
// renderer NEL MOMENTO in cui si mostrano, così la storia cambia lingua con
// l'interfaccia. Le entry vecchie (o con id sconosciuto) mostrano il loro
// content com'è: mai crash, nessuna migrazione del database.
//
// K2 (fase 17a): chi chiama queste funzioni deve usare useLingui() nel
// componente, così il cambio lingua ri-renderizza e il testo si aggiorna.
import { i18n } from '@lingui/core'
import type { TranscriptEntry, UiText } from '../../../shared/types'
import { toolDisplayName, type ToolDisplayCtx } from '../../../shared/tool-names'
import type { UiLanguage } from '../../../shared/ui-language'

/** Un UiText (o lista) dal meta di una entry, già normalizzato. */
export function uiListOf(meta: Record<string, unknown> | null | undefined): UiText[] | null {
  const raw = meta?.ui
  if (!raw || typeof raw !== 'object') return null
  const one = (v: unknown): UiText | null => {
    const c = v as { id?: unknown; values?: unknown } | null
    if (!c || typeof c.id !== 'string') return null
    const values = c.values && typeof c.values === 'object' ? (c.values as Record<string, string | number>) : undefined
    return { id: c.id, ...(values ? { values } : {}) }
  }
  if (Array.isArray(raw)) {
    const list = raw.map(one).filter((v): v is UiText => v !== null)
    return list.length ? list : null
  }
  const single = one(raw)
  return single ? [single] : null
}

/** Il testo del meta.ui nella lingua attiva (null se l'entry non ce l'ha). */
export function uiTextOfMeta(meta: Record<string, unknown> | null | undefined): string | null {
  const list = uiListOf(meta)
  if (!list) return null
  return list.map((u) => i18n._(u.id, u.values ?? {})).join('; ')
}

/** Il testo da mostrare dell'entry: meta.ui se c'è (nella lingua attiva), altrimenti il content. */
export function uiTextOf(entry: Pick<TranscriptEntry, 'content' | 'meta'>): string {
  return uiTextOfMeta(entry.meta) ?? entry.content
}

// ---- fase pulizia (P2): il nome dello strumento DENTRO i testi del meta.ui ----

/** Le id il cui valore {tool} è un DATO di configurazione, non un nome da umanizzare. */
const TOOL_VALUE_DATA_IDS = new Set(['trigger.tool'])

/** Il ctx di toolDisplayName ricavato dal meta dell'entry (mcpApp, composioAction). */
export function toolCtxOfMeta(meta: Record<string, unknown> | null | undefined, lang: UiLanguage): ToolDisplayCtx {
  const mcpApp = typeof meta?.mcpApp === 'string' ? meta.mcpApp : undefined
  const composioAction = meta?.composioAction as { app?: string; action?: string; original?: string } | undefined
  return {
    lang,
    ...(mcpApp ? { mcpServer: mcpApp } : {}),
    ...(composioAction && typeof composioAction === 'object' ? { composio: composioAction } : {})
  }
}

/**
 * P2: il testo del meta.ui col nome dello strumento IN PAROLE — il valore
 * {tool} passa da toolDisplayName («Creare un bot», «Slack · Create
 * reminder», «Notion · <strumento>»), così card e notice non mostrano mai il
 * nome tecnico. Le id dei dati di configurazione (trigger.tool) non si
 * toccano. Null se l'entry non ha meta.ui.
 */
export function uiTextOfMetaTools(meta: Record<string, unknown> | null | undefined, lang: UiLanguage): string | null {
  const list = uiListOf(meta)
  if (!list) return null
  const ctx = toolCtxOfMeta(meta, lang)
  return list
    .map((u) => {
      const tool = u.values?.tool
      if (tool === undefined || TOOL_VALUE_DATA_IDS.has(u.id)) return i18n._(u.id, u.values ?? {})
      return i18n._(u.id, { ...u.values, tool: toolDisplayName(String(tool), ctx) })
    })
    .join('; ')
}

/** Come uiTextOf, ma col nome dello strumento in parole (P2): vale il content senza meta.ui. */
export function uiTextOfTools(entry: Pick<TranscriptEntry, 'content' | 'meta'>, lang: UiLanguage = i18n.locale === 'en' ? 'en' : 'it'): string {
  return uiTextOfMetaTools(entry.meta, lang) ?? entry.content
}
