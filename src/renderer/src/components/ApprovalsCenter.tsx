// A2 (fase centro-autorizzazioni): la tavola 4 del disegno — «Da approvare:
// il centro per tutti i bot e le squadre». Tutte le richieste che spettano
// all'utente, in un posto: i gruppi (squadre con «Apri la squadra», poi i
// bot singoli), i filtri per tipo con i conteggi, le card con categoria,
// bot («tramite un sottoagente»), da quanto aspetta e il perché, i bottoni
// di OGGI per quel tipo di card. Il centro è una VISTA: ogni decisione
// passa dalla resolveApproval di oggi (o dai bottoni della bozza), deciso
// qui la card si chiude anche dove è nata — e viceversa. «Rimanda» nasconde
// per un'ora SOLO nella vista. Nessun «approva tutto», nessuna azione di
// gruppo. Più di 3 richieste dello stesso tipo nello stesso gruppo: «+N …
// Vedi» (tavola 4). I contatori di «Fatto da soli» sommati su tutti i bot
// costerebbero una passata su tutti i transcript a ogni refresh: resta il
// link al registro (Attività).
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { ShieldCheck, ArrowLeft, ChevronRight } from 'lucide-react'
import { api, useStore } from '../store'
import type { ApprovalsCenterRow, SquadPendingApprovalInfo } from '../../../shared/types'
import { visibleApprovalsRows, groupApprovalsRows, approvalsFilterCounts, APPROVALS_FILTERS, type ApprovalsGroup } from '../lib/approvals-center'

/** Le etichette dei chip di categoria (come la coda della squadra, tavola 2). */
const CATEGORY_LABEL: Record<SquadPendingApprovalInfo['category'], MessageDescriptor> = {
  'dati-tuoi': msg`i tuoi dati`,
  pagamento: msg`pagamento`,
  invio: msg`invio verso fuori`,
  'sito-interattivo': msg`sito nuovo, interattivo`,
  mac: msg`il tuo Mac`,
  squadra: msg`squadra`,
  altro: msg`altro`
}

const WHY_LABEL: Record<string, MessageDescriptor> = {
  contaminato: msg`contenuti non fidati nel turno`,
  revisore: msg`il revisore non è sicuro`,
  fisso: msg`sempre a te`
}

/** «2 min»: il tempo relativo dell'attesa (come la coda della squadra). */
function timeAgo(when: number, now: number): string {
  const s = Math.max(0, Math.round((now - when) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h`
  return `${Math.round(h / 24)} g`
}

/** «Consenti per questa missione» dove Q2 lo permette GIÀ: sito o squadra,
 *  con squadra, mai per l'insieme fisso e mai per le bozze. */
function missionOffered(r: ApprovalsCenterRow): boolean {
  return !r.isDraft && r.squad !== null && r.why !== 'fisso' &&
    (r.category === 'sito-interattivo' || r.category === 'squadra')
}

/** Una card del centro. */
function CenterCard({ r, now }: { r: ApprovalsCenterRow; now: number }) {
  const { i18n } = useLingui()
  const resolveApproval = useStore((s) => s.resolveApproval)
  const refreshSquadData = useStore((s) => s.refreshSquadData)
  const snooze = useStore((s) => s.approvalsSnooze)
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState('')
  // la decisione passa dai percorsi di oggi: resolveApproval per le card,
  // i bottoni della bozza per gli invii (con l'agente DELLA card)
  const resolve = (decision: 'allow' | 'deny', mode: 'once' | 'mission'): void => {
    resolveApproval(r.agentId, r.approvalId, decision, mode)
    refreshSquadData({ forceBadges: true })
  }
  return (
    <article
      className="rounded-[18px] bg-card p-4 shadow-soft"
      data-testid="approvals-center-card"
      data-approval-id={r.approvalId}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] text-foreground/80">{i18n.t(CATEGORY_LABEL[r.category])}</span>
        {r.why && <span className="text-xs text-muted-foreground">{i18n.t(WHY_LABEL[r.why]!)}</span>}
      </div>
      <p className="mt-1.5 text-sm">
        <span className="font-medium">{r.botName}</span>
        {r.fromSubagent && <span className="text-muted-foreground"> · <Trans>tramite un sottoagente</Trans></span>}
        <span className="text-xs text-muted-foreground"> · <Trans>aspetta da {timeAgo(r.when, now)}</Trans></span>
      </p>
      <p className="mt-1.5 text-sm leading-relaxed">{r.phrase}</p>
      {r.preview && (
        <p className="mt-1 text-xs text-muted-foreground">
          {r.preview.to && <Trans>A: {r.preview.to}</Trans>}
          {r.preview.to && r.preview.subject ? ' · ' : ''}
          {r.preview.subject && <Trans>Oggetto: {r.preview.subject}</Trans>}
          {r.preview.url && (r.preview.url.startsWith('http') ? r.preview.url.replace(/^https?:\/\//, '') : r.preview.url)}
          {r.preview.origin && r.preview.origin.replace(/^https?:\/\//, '')}
        </p>
      )}
      {editing && (
        <div className="mt-2">
          <textarea
            className="min-h-24 w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label={i18n.t(msg`Il testo della bozza`)}
          />
          <div className="mt-1.5 flex gap-2">
            <button
              className="rounded-full bg-foreground px-3.5 py-1.5 text-sm text-background"
              onClick={() => {
                void api.draftSend(r.agentId, r.entryId, body).catch(() => undefined)
                setEditing(false)
                refreshSquadData({ forceBadges: true })
              }}
            >
              <Trans>Salva</Trans>
            </button>
            <button className="rounded-full px-3.5 py-1.5 text-sm text-muted-foreground" onClick={() => setEditing(false)}>
              <Trans>Annulla</Trans>
            </button>
          </div>
        </div>
      )}
      {!editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          {r.isDraft ? (
            <>
              <button
                className="rounded-full bg-foreground px-4 py-2 text-sm text-background transition hover:opacity-90"
                data-testid="approval-draft-send"
                onClick={() => { void api.draftSend(r.agentId, r.entryId, '').catch(() => undefined); refreshSquadData({ forceBadges: true }) }}
              >
                <Trans>Invia</Trans>
              </button>
              <button
                className="rounded-full bg-muted px-4 py-2 text-sm transition hover:bg-accent"
                data-testid="approval-draft-edit"
                onClick={() => { setBody(''); setEditing(true) }}
              >
                <Trans>Modifica</Trans>
              </button>
              <button
                className="rounded-full px-4 py-2 text-sm text-muted-foreground transition hover:text-destructive"
                data-testid="approval-deny"
                onClick={() => { void api.draftDiscard(r.agentId, r.entryId).catch(() => undefined); refreshSquadData({ forceBadges: true }) }}
              >
                <Trans>Rifiuta</Trans>
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded-full bg-foreground px-4 py-2 text-sm text-background transition hover:opacity-90"
                data-testid="approval-allow-once"
                onClick={() => resolve('allow', 'once')}
              >
                <Trans>Consenti una volta</Trans>
              </button>
              {missionOffered(r) && (
                <button
                  className="rounded-full bg-muted px-4 py-2 text-sm transition hover:bg-accent"
                  data-testid="approval-mission"
                  title={i18n.t(msg`Un consenso di 8 ore per tutta la squadra, solo per questo`)}
                  onClick={() => resolve('allow', 'mission')}
                >
                  <Trans>Consenti per questa missione</Trans>
                </button>
              )}
              <button
                className="rounded-full px-4 py-2 text-sm text-muted-foreground transition hover:text-destructive"
                data-testid="approval-deny"
                onClick={() => resolve('deny', 'once')}
              >
                <Trans>Rifiuta</Trans>
              </button>
            </>
          )}
          <button
            className="rounded-full px-4 py-2 text-sm text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
            data-testid="approval-snooze"
            title={i18n.t(msg`Sparisce da qui per un'ora; resta in attesa nel bot`)}
            onClick={() => snooze(r.approvalId)}
          >
            <Trans>Rimanda</Trans>
          </button>
        </div>
      )}
    </article>
  )
}

/** il gruppo con il collasso «+N … Vedi» per tipo (tavola 4: più di 3 dello
 *  stesso tipo → le altre in una riga che si espande). */
function GroupSection({ g, now }: { g: ApprovalsGroup; now: number }) {
  const { i18n } = useLingui()
  const openGroup = useStore((s) => s.openGroup)
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // per tipo, nel gruppo: le prime 3 e le altre collassate
  const byCategory = new Map<string, ApprovalsCenterRow[]>()
  for (const r of g.rows) {
    const list = byCategory.get(r.category) ?? []
    list.push(r)
    byCategory.set(r.category, list)
  }
  const shown: ApprovalsCenterRow[] = []
  const hidden: Array<{ category: string; rows: ApprovalsCenterRow[] }> = []
  for (const [category, rows] of byCategory) {
    if (rows.length > 3 && !expanded[category]) {
      shown.push(...rows.slice(0, 3))
      hidden.push({ category, rows: rows.slice(3) })
    } else {
      shown.push(...rows)
    }
  }
  return (
    <section className="mt-6" aria-label={g.kind === 'squad' ? g.squad!.name : g.bot!.botName} data-testid="approvals-center-group">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg">
          {g.kind === 'squad' ? g.squad!.name : g.bot!.botName}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {g.kind === 'squad' ? `squadra · ${g.rows.length}` : `bot · ${g.rows.length}`}
          </span>
        </h2>
        {g.kind === 'squad' && (
          <button
            className="flex items-center gap-0.5 text-sm text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
            onClick={() => { openGroup(g.squad!.id); setApprovalsOpen(false) }}
          >
            <Trans>Apri la squadra</Trans> <ChevronRight className="size-3.5" />
          </button>
        )}
      </div>
      <div className="mt-3 space-y-3">
        {shown.map((r) => <CenterCard key={`${r.agentId}:${r.approvalId}`} r={r} now={now} />)}
        {hidden.map((h) => (
          <div key={h.category} className="flex items-baseline justify-between gap-3 rounded-[14px] bg-muted/50 px-3.5 py-2">
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              +{h.rows.length} {h.rows[0]!.phrase.replace(/\.$/, '').slice(0, 60)}{h.rows[0]!.phrase.length > 60 ? '…' : ''}, <Trans>di {h.rows[0]!.botName}</Trans>
            </span>
            <button
              className="shrink-0 text-sm text-foreground underline-offset-2 transition hover:underline"
              onClick={() => setExpanded((v) => ({ ...v, [h.category]: true }))}
            >
              <Trans>Vedi</Trans>
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

export function ApprovalsCenter() {
  const { i18n } = useLingui()
  const approvalsAll = useStore((s) => s.approvalsAll)
  const approvalsSnoozed = useStore((s) => s.approvalsSnoozed)
  const approvalsFocusId = useStore((s) => s.approvalsFocusId)
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  const setActivityOpen = useStore((s) => s.setActivityOpen)
  const [filter, setFilter] = useState<'all' | 'dati-tuoi' | 'invio' | 'sito-interattivo'>('all')
  const now = Date.now()
  const rows = visibleApprovalsRows(approvalsAll, approvalsSnoozed, now)
  const counts = approvalsFilterCounts(rows)
  const filtered = filter === 'all' ? rows : rows.filter((r) => r.category === filter)
  const grouped = groupApprovalsRows(filtered)
  const bots = new Set(rows.map((r) => r.botId)).size

  // aperto su UNA richiesta (dal riquadro o dalla notifica): la card entra e
  // si evidenzia una volta sola
  useEffect(() => {
    if (!approvalsFocusId) return
    const el = document.querySelector(`[data-approval-id="${CSS.escape(approvalsFocusId)}"]`)
    if (el) {
      el.scrollIntoView({ block: 'center' })
      useStore.setState({ approvalsFocusId: null })
    }
  }, [approvalsFocusId, grouped])

  return (
    <section className="absolute inset-0 z-20 flex flex-col bg-background" aria-label={i18n.t(msg`Da approvare`)} data-testid="approvals-center">
      <div className="px-8 pb-2 pt-10">
        <div className="mx-auto flex max-w-3xl items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 font-display text-2xl"><ShieldCheck className="size-5 text-muted-foreground" /><Trans>Da approvare</Trans></h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {rows.length > 0
                ? <Trans>{rows.length} richieste da {bots} bot · solo tu puoi deciderle · ogni richiesta si decide anche dove è nata</Trans>
                : <Trans>Nessuna richiesta in attesa.</Trans>}
            </p>
          </div>
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-3.5 py-2 text-sm transition hover:bg-accent"
            data-testid="approvals-center-close"
            onClick={() => setApprovalsOpen(false)}
          >
            <ArrowLeft className="size-4" /> <Trans>Chiudi</Trans>
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scroll-thin px-8 pb-6">
        <div className="mx-auto max-w-3xl">
          {/* i filtri per tipo, con i conteggi (solo i tipi con richieste) */}
          <div className="flex flex-wrap gap-2 pt-2" role="group" aria-label={i18n.t(msg`Filtra per tipo`)}>
            <button
              className={`rounded-full px-3.5 py-1.5 text-sm transition ${filter === 'all' ? 'bg-foreground text-background' : 'bg-muted hover:bg-accent'}`}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              <Trans>Tutte · {rows.length}</Trans>
            </button>
            {APPROVALS_FILTERS.map((f) => (
              counts[f.id] > 0 && (
                <button
                  key={f.id}
                  className={`rounded-full px-3.5 py-1.5 text-sm transition ${filter === f.id ? 'bg-foreground text-background' : 'bg-muted hover:bg-accent'}`}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {i18n.t(f.label)} · {counts[f.id]}
                </button>
              )
            ))}
          </div>
          {grouped.map((g) => <GroupSection key={g.kind === 'squad' ? `s${g.squad!.id}` : `b${g.bot!.botId}`} g={g} now={now} />)}
          {/* il riquadro in fondo: i contatori di «Fatto da soli» sommati su
              tutti i bot costerebbero una passata sui transcript a OGNI
              refresh — resta il link al registro di oggi (Attività) */}
          <div className="mt-8 flex items-center justify-between gap-3 rounded-[16px] bg-muted/50 px-4 py-3">
            <p className="text-sm text-muted-foreground"><Trans>Nessuna richiesta di dati tuoi, pagamenti o invii passa senza di te.</Trans></p>
            <button
              className="shrink-0 text-sm text-foreground underline-offset-2 transition hover:underline"
              onClick={() => { setActivityOpen(true); setApprovalsOpen(false) }}
            >
              <Trans>Registro di oggi</Trans>
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
