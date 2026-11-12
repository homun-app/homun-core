// Widget ask_user (report §3bis L10): domande con scelte cliccabili, la
// risposta torna come messaggio utente con meta.respondedTo e il widget salva
// respondedValue. Se l'utente scrive altro senza rispondere e il widget ha
// dismissOnMoveOn, viene marcato widgetDismissed. Funzioni PURE sul transcript.
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload, WidgetOption } from '../../shared/types'

const metaOf = (e: TranscriptEntry): SendMessageMeta | null => {
  if (e.kind !== 'send-message' || !e.meta) return null
  const m = e.meta as Partial<SendMessageMeta>
  return m.message ? (m as SendMessageMeta) : null
}

/** Entry send-message di tipo widget (o null). */
export function widgetPayload(e: TranscriptEntry): Extract<SendMessagePayload, { type: 'widget' }> | null {
  const m = metaOf(e)
  return m?.message.type === 'widget' ? m.message : null
}

/**
 * Widget ancora senza risposta, con dismissOnMoveOn: l'utente ha scritto
 * altro senza rispondere → questi vanno marcati widgetDismissed.
 */
export function findDismissibleWidgets(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((e) => {
    const w = widgetPayload(e)
    if (!w || !w.dismissOnMoveOn) return false
    const m = e.meta as Partial<SendMessageMeta>
    return m.respondedValue === undefined && !m.widgetDismissed
  })
}

/**
 * BC3 (fase beta.4 — correzioni): la card ask_user a cui un messaggio scritto
 * nella casella si collega (PURA). Vale solo se il turno è fermo su
 * AWAITING_USER e l'ULTIMA entry del bot è una domanda ancora senza risposta:
 * una card più vecchia di un'altra entry del bot (testo, altra card) NON si
 * collega — conta solo l'ultima. Le card dei TASK restano fuori (si risponde
 * nella vista del task, non dalla casella della chat). Null negli altri casi.
 */
export function answerableAskUser(entries: TranscriptEntry[]): TranscriptEntry | null {
  // l'ultimo esito di turno dev'essere AWAITING_USER (il turno è fermo lì)
  let awaiting = false
  for (let i = entries.length - 1; i >= 0; i--) {
    const turnEnd = (entries[i]!.meta as { turnEnd?: string } | null)?.turnEnd
    if (turnEnd !== undefined) {
      if (turnEnd !== 'AWAITING_USER') return null
      awaiting = true
      break
    }
  }
  if (!awaiting) return null
  // l'ultima entry del bot: deve essere PROPRIO la card, ancora aperta
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind !== 'send-message' || e.role !== 'assistant') continue
    const w = widgetPayload(e)
    if (!w) return null
    const m = e.meta as Partial<SendMessageMeta>
    if (m.respondedValue !== undefined || m.widgetDismissed) return null
    if (m.taskId !== undefined) return null
    return e
  }
  return null
}

/**
 * Testo del messaggio utente che porta la risposta del widget: le etichette
 * delle opzioni scelte (valore → label), o il testo libero se allowCustom.
 */
export function responseDisplayText(
  w: Extract<SendMessagePayload, { type: 'widget' }>,
  value: string | string[]
): string {
  const values = Array.isArray(value) ? value : [value]
  const labels = values.map((v) => w.options.find((o) => o.value === v)?.label ?? v)
  return labels.join(', ')
}

/** Le opzioni di un widget normalizzate (difensivo sui tipi che arrivano dal modello). */
export function normalizeOptions(raw: unknown): WidgetOption[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (o): o is WidgetOption => !!o && typeof o === 'object' && typeof (o as WidgetOption).label === 'string'
  ).map((o) => ({
    label: o.label,
    value: typeof o.value === 'string' && o.value ? o.value : o.label,
    ...(o.description ? { description: o.description } : {}),
    ...(o.style ? { style: o.style } : {})
  }))
}
