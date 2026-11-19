// A2/A3 (fase centro-autorizzazioni): la logica PURA del centro «Da
// approvare» e del riquadro delle chat — quali richieste si vedono (i
// «Rimanda» di un'ora sono SOLO vista), come si raggruppano (squadre, poi
// bot singoli), l'urgenza (prima l'insieme fisso, poi la più vecchia) e i
// conteggi dei filtri. Le decisioni passano sempre da resolveApproval: qui
// non si decide niente.
import type { ApprovalsCenterRow, SquadPendingApprovalInfo } from '../../../shared/types'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

/** l'ora di «Rimanda»: la richiesta resta in attesa nel bot, si nasconde solo qui */
export const APPROVALS_SNOOZE_MS = 60 * 60 * 1000

/** le richieste visibili: i «Rimanda» non scaduti restano nascosti (solo nella vista). */
export function visibleApprovalsRows(rows: ApprovalsCenterRow[], snoozed: Record<string, number> | null | undefined, now: number): ApprovalsCenterRow[] {
  const s = snoozed ?? {}
  return rows.filter((r) => !(s[r.approvalId] !== undefined && now < s[r.approvalId]!))
}

/** l'ordine d'urgenza della tavola 5: prima l'insieme fisso, poi la più vecchia. */
export function byUrgency(rows: ApprovalsCenterRow[]): ApprovalsCenterRow[] {
  return [...rows].sort((a, b) => {
    const fa = a.why === 'fisso' ? 0 : 1
    const fb = b.why === 'fisso' ? 0 : 1
    if (fa !== fb) return fa - fb
    return a.when - b.when
  })
}

/** un gruppo del centro: una squadra o un bot singolo. */
export interface ApprovalsGroup {
  kind: 'squad' | 'bot'
  squad: { id: number; name: string } | null
  bot: ApprovalsCenterRow | null
  rows: ApprovalsCenterRow[]
}

/**
 * Il raggruppamento della tavola 4: squadra → poi bot singoli. L'ordine dei
 * gruppi è quello d'urgenza (la prima riga di ogni gruppo), dentro un gruppo
 * l'ordine delle righe resta quello d'urgenza.
 */
export function groupApprovalsRows(rows: ApprovalsCenterRow[]): ApprovalsGroup[] {
  const ordered = byUrgency(rows)
  const groups: ApprovalsGroup[] = []
  const keyOf = (r: ApprovalsCenterRow): string => (r.squad ? `s:${r.squad.id}` : `b:${r.botId}`)
  for (const r of ordered) {
    const key = keyOf(r)
    let g = groups.find((x) => keyOf(x.rows[0]!) === key)
    if (!g) {
      g = r.squad ? { kind: 'squad', squad: r.squad, bot: null, rows: [] } : { kind: 'bot', squad: null, bot: r, rows: [] }
      groups.push(g)
    }
    g.rows.push(r)
  }
  return groups.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'squad' ? -1 : 1
    return (a.rows[0]?.when ?? 0) - (b.rows[0]?.when ?? 0)
  })
}

/** i tipi dei filtri della tavola 4, con le categorie che contano. */
export const APPROVALS_FILTERS: Array<{ id: 'dati-tuoi' | 'invio' | 'sito-interattivo'; label: MessageDescriptor }> = [
  { id: 'dati-tuoi', label: msg`I tuoi dati` },
  { id: 'invio', label: msg`Invii` },
  { id: 'sito-interattivo', label: msg`Siti` }
]

/** i conteggi dei filtri: quante richieste per ogni tipo (0 = filtro nascosto). */
export function approvalsFilterCounts(rows: ApprovalsCenterRow[]): Record<'dati-tuoi' | 'invio' | 'sito-interattivo', number> {
  const c = { 'dati-tuoi': 0, invio: 0, 'sito-interattivo': 0 } as Record<'dati-tuoi' | 'invio' | 'sito-interattivo', number>
  for (const r of rows) {
    if (r.category === 'dati-tuoi' || r.category === 'invio' || r.category === 'sito-interattivo') c[r.category]++
  }
  return c
}

/** le etichette corte del riquadro («2 siti interattivi, 1 login»). */
export const CATEGORY_SHORT: Record<SquadPendingApprovalInfo['category'], MessageDescriptor> = {
  'dati-tuoi': msg`login`,
  pagamento: msg`pagamenti`,
  invio: msg`invii`,
  'sito-interattivo': msg`siti interattivi`,
  mac: msg`uso del Mac`,
  squadra: msg`squadra`,
  altro: msg`altro`
}
