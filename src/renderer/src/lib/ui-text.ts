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
