// Fase 16c (C5): le righe dell'Attività globale come FUNZIONE PURA (tavola 4,
// sinistra): task di tutti i bot, esecuzioni delle routine e i bot che
// aspettano te. L'ordine mette in cima chi lavora e chi aspetta, poi la data.
import type { GlobalActivityData, ActivityFailReason } from '../../../shared/types'

/** I filtri a pillola della vista Attività. */
export type ActivityFilter = 'all' | 'mine' | 'routines' | 'failed'

/** La riga resa dalla vista. */
export interface ActivityRow {
  key: string
  /** task | routine | attesa */
  kind: 'task' | 'routine' | 'waiting'
  agentId: string
  title: string
  /** lo stato della riga, già deciso (il colore lo sceglie la vista) */
  status: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'
  /** task: quando è stato toccato; routine: quando è finita (o è iniziata se in corso) */
  at: number
  /** il summary troncato del task finito */
  summary: string | null
  /** il CODICE del motivo del fallimento (null = niente) */
  reason: ActivityFailReason | null
  /** l'id del task (per aprirlo nella vista di oggi); le routine non ce l'hanno */
  taskId: number | null
  /** le routine (e i task automatici) mostrano «· routine» accanto al nome */
  routine: boolean
}

const MAX_SUMMARY = 140

/**
 * PURA: task + routine + attese in righe ordinate e filtrate.
 * L'ordine: le attese in CIMA, poi chi lavora, poi tutto il resto per data
 * (la più recente prima). I filtri: 'mine' = i task nati da te (automatic = 0);
 * 'routines' = le esecuzioni delle routine; 'failed' = task e routine non
 * riuscite. La ricerca cerca nel titolo e nel summary.
 */
export function activityRows(data: GlobalActivityData, filter: ActivityFilter, query: string): ActivityRow[] {
  const q = query.trim().toLowerCase()
  const rows: ActivityRow[] = []

  for (const t of data.tasks) {
    const status: ActivityRow['status'] =
      t.status === 'working' ? 'running'
        : t.status === 'needs_input' ? 'waiting'
          : t.status === 'done' ? 'done'
            : t.status === 'failed' ? 'failed'
              : 'cancelled'
    rows.push({
      key: `task:${t.id}`,
      kind: 'task',
      agentId: t.agentId,
      title: t.title,
      status,
      at: t.updatedAt,
      summary: t.summary ? t.summary.slice(0, MAX_SUMMARY) : null,
      reason: null,
      taskId: t.id,
      routine: t.automatic === 1
    })
  }
  for (const r of data.runs) {
    const status: ActivityRow['status'] =
      r.endedAt === null ? 'running' : r.outcome === 'ok' ? 'done' : r.outcome === 'cancelled' ? 'cancelled' : 'failed'
    rows.push({
      key: `run:${r.id}`,
      kind: 'routine',
      agentId: r.agentId,
      title: r.title,
      status,
      at: r.endedAt ?? r.startedAt,
      summary: null,
      reason: status === 'failed' ? r.reason : null,
      taskId: null,
      routine: true
    })
  }
  for (const agentId of data.waiting) {
    rows.push({
      key: `waiting:${agentId}`,
      kind: 'waiting',
      agentId,
      title: '',
      status: 'waiting',
      // l'attesa è ADESSO: in cima al suo gruppo d'ordine
      at: Number.MAX_SAFE_INTEGER,
      summary: null,
      reason: null,
      taskId: null,
      routine: false
    })
  }

  return rows
    .filter((row) => {
      if (q && !`${row.title} ${row.summary ?? ''}`.toLowerCase().includes(q)) return false
      if (filter === 'mine') return row.kind === 'task' && row.routine === false
      if (filter === 'routines') return row.routine
      if (filter === 'failed') return row.status === 'failed'
      return true
    })
    .sort((a, b) => rankOf(a) - rankOf(b) || b.at - a.at)
}

/** Le attese contano di più, poi chi lavora; il resto per data. */
function rankOf(r: ActivityRow): number {
  if (r.status === 'waiting') return 0
  if (r.status === 'running') return 1
  return 2
}
