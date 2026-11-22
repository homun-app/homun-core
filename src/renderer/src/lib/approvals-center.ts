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
  squadra: msg`team`,
  altro: msg`altro`
}

// ---- A2 (fase approvazioni-chiare): il Registro ----

import type { ApprovalLogRow } from '../../../shared/types'

/** i filtri del registro: Approvate / Rifiutate / Scadute / Passate da sole. */
export const REGISTRO_FILTERS: Array<{ id: 'approve' | 'deny' | 'expired' | 'auto'; label: MessageDescriptor }> = [
  { id: 'approve', label: msg`Approvate` },
  { id: 'deny', label: msg`Rifiutate` },
  { id: 'expired', label: msg`Scadute` },
  { id: 'auto', label: msg`Passate da sole` }
]

/** una riga del registro come la mostra la lista: la scelta e il «da dove» in parole. */
export interface RegistroRow extends ApprovalLogRow {
  /** la scelta in parole («Consentito sempre», «Rifiutato»…) — null per le righe vecchie */
  choice: MessageDescriptor | null
  choiceDomain: string | null
  /** il «da dove» in parole («dalla chat», «dal centro»…) — null per le vecchie */
  viaLabel: MessageDescriptor | null
  /** l'ora della riga, «HH:MM» */
  time: string
}

/** la scelta in parole dal verdetto del registro (PURA). */
export function registroChoiceOf(r: ApprovalLogRow): { choice: MessageDescriptor | null; domain: string | null } {
  if (r.legacy || r.decision == null) return { choice: null, domain: null }
  if (r.decision === 'deny') return { choice: msg`Rifiutato`, domain: null }
  if (r.decision === 'expired') return { choice: msg`Scaduto`, domain: null }
  if (r.decision === 'auto') return { choice: msg`Passata da sola`, domain: r.allowedBy }
  switch (r.mode) {
    case 'turn': return { choice: msg`Consentito per il turno`, domain: null }
    case 'minutes10': return { choice: msg`Consentito per 10 minuti`, domain: null }
    case 'always': return { choice: msg`Consentito sempre`, domain: null }
    case 'site': return { choice: msg`Consentito sempre (sito)`, domain: null }
    case 'server-reads': return { choice: msg`Letture del server consentite`, domain: null }
    case 'mission': return { choice: msg`Consentito per la missione`, domain: null }
    default: return { choice: msg`Consentito una volta`, domain: null }
  }
}

/** il «da dove» in parole (PURA). */
export function registroViaLabelOf(r: ApprovalLogRow): MessageDescriptor | null {
  if (r.kind === 'auto') return r.allowedBy ? msg`da sola · ${r.allowedBy}` : null
  switch (r.via) {
    case 'chat': return msg`dalla chat`
    case 'center': return msg`dal centro`
    case 'notification': return msg`dalla notifica`
    case 'expired': return msg`senza risposta`
    default: return null
  }
}

/**
 * Il modello del registro (PURA): le righe nell'ordine dal più recente, con
 * la scelta e il «da dove» in parole e l'ora — e il filtro (all | approve |
 * deny | expired | auto).
 */
export function registroModel(rows: readonly ApprovalLogRow[], filter: 'all' | 'approve' | 'deny' | 'expired' | 'auto' = 'all'): RegistroRow[] {
  const wanted = (r: ApprovalLogRow): boolean => {
    if (filter === 'all') return true
    if (filter === 'auto') return r.kind === 'auto'
    if (filter === 'approve') return r.kind === 'decision' && r.decision === 'allow'
    if (filter === 'deny') return r.kind === 'decision' && r.decision === 'deny'
    return r.kind === 'decision' && r.decision === 'expired'
  }
  return rows.filter(wanted)
    .map((r) => {
      const { choice, domain } = registroChoiceOf(r)
      const d = new Date(r.at)
      return {
        ...r,
        choice,
        choiceDomain: domain,
        viaLabel: registroViaLabelOf(r),
        time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      }
    })
    .sort((a, b) => b.at - a.at)
}

/** un giorno del registro: le righe di una data, dall'alto il più recente. */
export interface RegistroDay {
  /** l'etichetta: «oggi», «ieri» o la data */
  label: string
  rows: RegistroRow[]
}

/** il raggruppamento per giorno (PURA): oggi, ieri, poi le date. */
export function groupRegistroByDay(rows: readonly RegistroRow[], now = Date.now(), lang: 'it' | 'en' = 'it'): RegistroDay[] {
  const dayKey = (t: number): string => {
    const d = new Date(t)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  }
  const labelOf = (t: number): string => {
    const today = new Date(now)
    const yesterday = new Date(now - 86_400_000)
    const d = new Date(t)
    if (dayKey(t) === dayKey(today.getTime())) return lang === 'en' ? 'today' : 'oggi'
    if (dayKey(t) === dayKey(yesterday.getTime())) return lang === 'en' ? 'yesterday' : 'ieri'
    return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT')
  }
  const days: RegistroDay[] = []
  for (const r of rows) {
    const label = labelOf(r.at)
    const cur = days[days.length - 1]
    if (cur && cur.label === label) cur.rows.push(r)
    else days.push({ label, rows: [r] })
  }
  return days
}
