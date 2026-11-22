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
import { useEffect, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { ShieldCheck, ArrowLeft, ChevronRight } from 'lucide-react'
import { api, useStore } from '../store'
import type { ApprovalsCenterRow, SquadPendingApprovalInfo, ApprovalLogRow } from '../../../shared/types'
import { visibleApprovalsRows, groupApprovalsRows, approvalsFilterCounts, APPROVALS_FILTERS, registroModel, groupRegistroByDay, REGISTRO_FILTERS, type ApprovalsGroup } from '../lib/approvals-center'
// A1 (fase approvazioni-chiare): il modello UNICO delle scelte, come la card
import { approvalChoicesOf, type ApprovalChoice } from '../lib/approval-app'
// A2: i nomi dei consensi e il raggruppamento per bot (come Impostazioni › Approvazioni)
import { grantDisplayName, groupGrantsByBot, type GrantLike } from '../lib/approval-app'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'

/** Le etichette dei chip di categoria (come la coda della squadra, tavola 2). */
const CATEGORY_LABEL: Record<SquadPendingApprovalInfo['category'], MessageDescriptor> = {
  'dati-tuoi': msg`i tuoi dati`,
  pagamento: msg`pagamento`,
  invio: msg`invio verso fuori`,
  'sito-interattivo': msg`sito nuovo, interattivo`,
  mac: msg`il tuo Mac`,
  squadra: msg`team`,
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

/** «Consenti per questa missione» dove Q2 lo permette GIÀ: la regola vive nel
 *  modello unico A1 (approvalChoicesOf) — il centro e la card leggono quello. */

/** Una card del centro. */
function CenterCard({ r, now }: { r: ApprovalsCenterRow; now: number }) {
  const { i18n } = useLingui()
  const { t } = useLingui()
  const resolveApproval = useStore((s) => s.resolveApproval)
  const refreshSquadData = useStore((s) => s.refreshSquadData)
  const snooze = useStore((s) => s.approvalsSnooze)
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState('')
  // A1 (fase approvazioni-chiare): le scelte dal modello UNICO della card —
  // il difetto del 22/11 era «In Da approvare ho sempre e solo una volta».
  // Il why 'fisso' della riga vale come il marcatore del meta (stessa fonte)
  const choices = approvalChoicesOf(
    r.tool,
    { ...(r.meta ?? {}), ...(r.why === 'fisso' ? { squadAlwaysAsk: true } : {}) },
    { isDraft: r.isDraft, squad: r.squad !== null, category: r.category }
  )
  const choiceLabelOf = (c: ApprovalChoice): string => {
    switch (c.kind) {
      case 'turn': return t`Per questo turno`
      case 'minutes10': return t`Consenti per 10 minuti a ${c.app ?? ''}`
      case 'always': return t`Consenti sempre a ${r.botName}`
      case 'server-reads': return t`Consenti sempre le letture di ${c.name ?? c.slug ?? ''}`
      case 'site': return t`Consenti sempre su ${c.domain ?? ''}`
      case 'mission': return t`Consenti per questa missione`
    }
  }
  const choiceTitleOf = (c: ApprovalChoice): string | undefined => {
    switch (c.kind) {
      case 'turn': return c.disabled ? t`Questa azione chiede sempre l'approvazione` : t`Vale per lo stesso tool fino alla fine di questo turno`
      case 'minutes10': return t`Le azioni su ${c.app ?? ''} non chiederanno per 10 minuti`
      case 'always': return c.disabled ? t`Questa azione chiede sempre l'approvazione` : undefined
      case 'server-reads': return t`Le letture di questo server non chiederanno più (solo i tool dichiarati in sola lettura)`
      case 'site':
        return t`Navigare, aprire link e cliccare controlli non di conferma su ${c.domain ?? ''} non chiederanno più; le conferme, i pagamenti e i dati tuoi sì. Revocabile in Impostazioni › Approvazioni.`
      case 'mission': return t`Un consenso di 8 ore per tutto il team, solo per questo`
    }
  }
  // la decisione passa dai percorsi di oggi: resolveApproval per le card,
  // i bottoni della bozza per gli invii (con l'agente DELLA card); per le
  // letture del server la grant dedicata + once, come la card in chat
  const notificationFocus = useStore((s) => s.approvalsNotificationFocus)
  const clearNotificationFocus = useStore((s) => s.clearApprovalsNotificationFocus)
  const resolve = (decision: 'allow' | 'deny', mode: 'once' | 'turn' | 'minutes10' | 'always' | 'site' | 'mission' | 'server-reads'): void => {
    // A2: la richiesta su cui ha portato il clic della notifica, decisa qui,
    // si registra con via 'notification'; le altre del centro con 'center'
    const via = notificationFocus === r.approvalId ? 'notification' : 'center'
    if (notificationFocus === r.approvalId) clearNotificationFocus()
    resolveApproval(r.agentId, r.approvalId, decision, mode, via)
    refreshSquadData({ forceBadges: true })
  }
  const decideChoice = (c: ApprovalChoice): void => {
    if (c.kind === 'server-reads') {
      void api.grantServerReads(c.slug!).catch(() => undefined)
      // A2: mode 'server-reads' — la chiamata passa, il registro ricorda il modo
      resolve('allow', 'server-reads')
      return
    }
    resolve('allow', c.kind)
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
              {/* A1: le altre scelte nel menu «Altre scelte ▾» — le STESSE
                  della card in chat, dal modello unico approvalChoicesOf */}
              {choices.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    data-testid="approval-altre-scelte"
                    className="rounded-full bg-muted px-4 py-2 text-sm transition hover:bg-accent"
                  >
                    <Trans>Altre scelte ▾</Trans>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {choices.map((c) => (
                      <DropdownMenuItem
                        key={c.kind}
                        data-testid={`approval-choice-${c.kind}`}
                        disabled={c.disabled === true}
                        title={choiceTitleOf(c)}
                        onClick={() => decideChoice(c)}
                      >
                        {choiceLabelOf(c)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
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
            {g.kind === 'squad' ? i18n.t(msg`team · ${g.rows.length}`) : i18n.t(msg`bot · ${g.rows.length}`)}
          </span>
        </h2>
        {g.kind === 'squad' && (
          <button
            className="flex items-center gap-0.5 text-sm text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
            onClick={() => { openGroup(g.squad!.id); setApprovalsOpen(false) }}
          >
            <Trans>Apri il team</Trans> <ChevronRight className="size-3.5" />
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

/** i dati iniziali del Registro (nei test senza effect; nel prodotto si caricano dall'api) */
export interface RegistroInitial {
  log?: ApprovalLogRow[]
  grants?: GrantLike[]
}

export function ApprovalsCenter({ registroInitial }: { registroInitial?: RegistroInitial } = {}) {
  const { i18n } = useLingui()
  const approvalsAll = useStore((s) => s.approvalsAll)
  const approvalsSnoozed = useStore((s) => s.approvalsSnoozed)
  const approvalsFocusId = useStore((s) => s.approvalsFocusId)
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  // A2 (fase approvazioni-chiare): le due schede del centro — le richieste in
  // attesa e il REGISTRO delle decisioni (con «Consentiti sempre»)
  const approvalsView = useStore((s) => s.approvalsView)
  const setApprovalsView = useStore((s) => s.setApprovalsView)
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
            {approvalsView === 'richieste' && (
              <p className="mt-1 text-sm text-muted-foreground">
                {rows.length > 0
                  ? <Trans>{rows.length} richieste da {bots} bot · solo tu puoi deciderle · ogni richiesta si decide anche dove è nata</Trans>
                  : <Trans>Nessuna richiesta in attesa.</Trans>}
              </p>
            )}
            {/* A2: le due schede — le richieste in attesa e il Registro */}
            <div className="mt-2 flex items-center gap-1.5" data-testid="approvals-center-tabs">
              {([['richieste', i18n.t(msg`Richieste`)], ['registro', i18n.t(msg`Registro`)]] as const).map(([id, label]) => (
                <button
                  key={id}
                  className={`rounded-full px-3 py-1 text-[13px] transition ${approvalsView === id ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                  data-testid={`approvals-tab-${id}`}
                  onClick={() => setApprovalsView(id)}
                >
                  {label}
                </button>
              ))}
            </div>
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
        {approvalsView === 'registro' ? (
          <RegistroView initial={registroInitial} />
        ) : (
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
          {/* A2: «Registro di oggi» porta al REGISTRO del centro (prima ad
              Attività, che delle approvazioni non sapeva nulla) */}
          <div className="mt-8 flex items-center justify-between gap-3 rounded-[16px] bg-muted/50 px-4 py-3">
            <p className="text-sm text-muted-foreground"><Trans>Nessuna richiesta di dati tuoi, pagamenti o invii passa senza di te.</Trans></p>
            <button
              className="shrink-0 text-sm text-foreground underline-offset-2 transition hover:underline"
              data-testid="approvals-open-registro"
              onClick={() => setApprovalsView('registro')}
            >
              <Trans>Registro di oggi</Trans>
            </button>
          </div>
        </div>
        )}
      </div>
    </section>
  )
}

// ---- A2: il Registro — le decisioni, le passate da sole, i consentiti sempre ----

/** il registro: le righe per giorno, i filtri e «Consentiti sempre» con Revoca. */
function RegistroView({ initial }: { initial?: RegistroInitial }): ReactNode {
  const { i18n } = useLingui()
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const [log, setLog] = useState<ApprovalLogRow[] | null>(initial?.log ?? null)
  const [grants, setGrants] = useState<GrantLike[] | null>(initial?.grants ?? null)
  const [filter, setFilter] = useState<'all' | 'approve' | 'deny' | 'expired' | 'auto'>('all')
  const lang = i18n.locale === 'en' ? 'en' : 'it'

  const reload = (): void => {
    void api.approvalsLog(200).then(setLog).catch(() => setLog([]))
    void api.grantsList().then(setGrants).catch(() => setGrants([]))
  }
  useEffect(reload, [])
  const rows = registroModel(log ?? [], filter)
  const days = groupRegistroByDay(rows, Date.now(), lang)
  const counts = (id: typeof filter): number => registroModel(log ?? [], id).length

  return (
    <div className="mx-auto max-w-3xl" data-testid="approvals-registro">
      {/* i filtri del registro */}
      <div className="flex flex-wrap gap-2 pt-2" role="group" aria-label={i18n.t(msg`Filtra il registro`)}>
        <button
          className={`rounded-full px-3.5 py-1.5 text-sm transition ${filter === 'all' ? 'bg-foreground text-background' : 'bg-muted hover:bg-accent'}`}
          aria-pressed={filter === 'all'}
          onClick={() => setFilter('all')}
        >
          <Trans>Tutte</Trans>
        </button>
        {REGISTRO_FILTERS.map((f) => (
          counts(f.id) > 0 && (
            <button
              key={f.id}
              className={`rounded-full px-3.5 py-1.5 text-sm transition ${filter === f.id ? 'bg-foreground text-background' : 'bg-muted hover:bg-accent'}`}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {i18n.t(f.label)} · {counts(f.id)}
            </button>
          )
        ))}
      </div>
      {log === null && <p className="mt-4 text-sm text-muted-foreground"><Trans>caricamento…</Trans></p>}
      {log !== null && rows.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground"><Trans>Nessuna decisione registrata.</Trans></p>
      )}
      {days.map((d) => (
        <section key={d.label} className="mt-6" data-testid="approvals-registro-day">
          <h2 className="text-[15px] font-medium capitalize">{d.label}</h2>
          <div className="mt-2 space-y-1.5">
            {d.rows.map((r) => (
              <div key={r.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-[14px] bg-muted/40 px-3.5 py-2" data-testid="approvals-registro-row">
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium">{r.botName}</span>
                  <span className="text-muted-foreground"> · {r.phrase || r.tool}</span>
                </span>
                <span className={`text-[13px] ${r.decision === 'deny' || r.decision === 'expired' ? 'text-muted-foreground' : 'text-foreground'}`}>
                  {r.legacy
                    ? <Trans>decisione precedente al registro</Trans>
                    : <>
                        {r.choice ? i18n.t(r.choice) : r.tool}
                        {r.choiceDomain && <span className="text-muted-foreground"> · {r.choiceDomain}</span>}
                      </>}
                </span>
                <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                  {r.legacy ? '' : r.viaLabel ? i18n.t(r.viaLabel) : ''}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{r.time}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
      {/* «Consentiti sempre»: le grant attive, ciascuna con Revoca */}
      <section className="mt-8" data-testid="approvals-registro-grants">
        <h2 className="text-[15px] font-medium"><Trans>Consentiti sempre</Trans></h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground"><Trans>Ciò che i bot possono fare senza chiedere. Revoca e la chiamata successiva torna a chiedere.</Trans></p>
        {grants !== null && grants.length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground"><Trans>Nessun consenso sempre attivo.</Trans></p>
        )}
        <div className="mt-2 space-y-1.5">
          {groupGrantsByBot(grants ?? []).map((group) => (
            <div key={group.agentId ?? 'tutti'} className="rounded-[16px] bg-muted/40 px-3.5 py-2.5">
              <p className="text-[13px] font-medium">
                {group.agentId === null
                  ? <Trans>Tutti i bot</Trans>
                  : agents.find((a) => a.id === group.agentId)?.name ?? group.agentId}
              </p>
              <div className="mt-1 space-y-1">
                {group.grants.map((g) => (
                  <div key={g.id} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{grantDisplayName(g, lang)}</span>
                      {g.tool === 'run-command' && <code className="ml-1.5 rounded bg-card px-1 font-mono text-[11px]">{g.target}</code>}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t`dal ${new Date(g.createdAt).toLocaleDateString()}`}
                      {g.expiresAt != null ? <> · {t`scade alle ${new Date(g.expiresAt).toLocaleTimeString()}`}</> : null}
                    </span>
                    <button
                      className="shrink-0 text-[13px] text-muted-foreground underline-offset-2 transition hover:text-destructive hover:underline"
                      data-testid="grant-revoke"
                      onClick={() => { void api.grantRevoke(g.id).then(reload).catch(() => undefined) }}
                    >
                      <Trans>Revoca</Trans>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
