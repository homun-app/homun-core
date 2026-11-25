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
//
// Fase design (DS4): la pagina è fatta coi PEZZI di DS2, non più con classi
// scritte a mano. Il guscio è PageShell — il corpo che scorre è largo quanto
// l'area, e solo DENTRO il contenuto è centrato: 880 con le richieste, 1120
// col Registro, che è una tabella (PageShell ha una larghezza sola: la decide
// la vista). La testata è PageHeader: indietro, l'icona, il titolo, a destra
// «Registro di oggi», sotto la descrizione («N richieste da N bot»). Le
// schede «Richieste | Registro» stanno nel toolbar, FERME sopra il corpo. I
// gruppi sono Section, le decisioni del Registro una DataTable, i consensi
// righe a filo (FlatRow), i bottoni Button. Testid, nomi accessibili e testi
// restano quelli di oggi: li cercano le sonde delle fasi centro e
// uso-permessi (e li tiene ds4-approvazioni.test.ts).
import { useEffect, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { ChevronRight, ShieldCheck } from 'lucide-react'
import { api, useStore } from '../store'
import type { ApprovalsCenterRow, SquadPendingApprovalInfo, ApprovalLogRow } from '../../../shared/types'
import { visibleApprovalsRows, groupApprovalsRows, approvalsFilterCounts, APPROVALS_FILTERS, registroModel, groupRegistroByDay, REGISTRO_FILTERS, type ApprovalsGroup, type RegistroRow } from '../lib/approvals-center'
// A1 (fase approvazioni-chiare): il modello UNICO delle scelte, come la card
import { approvalChoicesOf, type ApprovalChoice } from '../lib/approval-app'
// A2: i nomi dei consensi e il raggruppamento per bot (come Impostazioni › Approvazioni)
import { grantDisplayName, groupGrantsByBot, type GrantLike } from '../lib/approval-app'
import { Button, buttonVariants } from './ui/button'
// C3 (fase linguaggio): i filtri passano dal corpo alla BARRA, col pezzo del catalogo
import { FilterChipsScelta } from './ui/filter-chips'
import { DataTable, Cell, CellStack, type DataTableColumn } from './ui/data-table'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { FlatList, FlatRow } from './ui/flat-list'
import { PageHeader } from './ui/page-header'
import { PageShell } from './ui/page-shell'
import { Section } from './ui/section'
import { UnderlineTabs } from './ui/underline-tabs'

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

/** Le due viste del centro: le richieste in attesa e il Registro. */
type ApprovalsView = 'richieste' | 'registro'

/** Una card del centro. */
function CenterCard({ r, now }: { r: ApprovalsCenterRow; now: number }) {
  const { i18n } = useLingui()
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
  const { t } = useLingui()
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
    // la scheda delle superfici (rounded-surface), col bordo e senza ombra: si stacca dal fondo come le altre schede del sistema
    <article
      className="rounded-surface border border-border bg-card p-4"
      data-testid="approvals-center-card"
      data-approval-id={r.approvalId}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-caption">{i18n.t(CATEGORY_LABEL[r.category])}</span>
        {r.why && <span className="text-caption text-muted-foreground">{i18n.t(WHY_LABEL[r.why]!)}</span>}
      </div>
      {/* il titolo della card è il nome del bot (text-body, peso medio); il resto della riga (il sottoagente, l'attesa) è grigio, in text-small */}
      <p className="mt-2 text-body">
        <span className="font-medium">{r.botName}</span>
        {r.fromSubagent && <span className="text-small text-muted-foreground"> · <Trans>tramite un sottoagente</Trans></span>}
        <span className="text-small text-muted-foreground"> · <Trans>aspetta da {timeAgo(r.when, now)}</Trans></span>
      </p>
      <p className="mt-1 text-body">{r.phrase}</p>
      {r.preview && (
        <p className="mt-1 text-small text-muted-foreground">
          {r.preview.to && <Trans>A: {r.preview.to}</Trans>}
          {r.preview.to && r.preview.subject ? ' · ' : ''}
          {r.preview.subject && <Trans>Oggetto: {r.preview.subject}</Trans>}
          {r.preview.url && (r.preview.url.startsWith('http') ? r.preview.url.replace(/^https?:\/\//, '') : r.preview.url)}
          {r.preview.origin && r.preview.origin.replace(/^https?:\/\//, '')}
        </p>
      )}
      {editing && (
        <div className="mt-3">
          <textarea
            className="min-h-24 w-full rounded-control bg-muted px-3 py-2 text-body outline-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label={i18n.t(msg`Il testo della bozza`)}
          />
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() => {
                void api.draftSend(r.agentId, r.entryId, body).catch(() => undefined)
                setEditing(false)
                refreshSquadData({ forceBadges: true })
              }}
            >
              <Trans>Salva</Trans>
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              <Trans>Annulla</Trans>
            </Button>
          </div>
        </div>
      )}
      {!editing && (
        <div className="mt-4 flex flex-wrap gap-2">
          {r.isDraft ? (
            <>
              <Button
                data-testid="approval-draft-send"
                onClick={() => { void api.draftSend(r.agentId, r.entryId, '').catch(() => undefined); refreshSquadData({ forceBadges: true }) }}
              >
                <Trans>Invia</Trans>
              </Button>
              <Button
                variant="secondary"
                data-testid="approval-draft-edit"
                onClick={() => { setBody(''); setEditing(true) }}
              >
                <Trans>Modifica</Trans>
              </Button>
              <Button
                variant="destructive"
                data-testid="approval-deny"
                onClick={() => { void api.draftDiscard(r.agentId, r.entryId).catch(() => undefined); refreshSquadData({ forceBadges: true }) }}
              >
                <Trans>Rifiuta</Trans>
              </Button>
            </>
          ) : (
            <>
              <Button
                data-testid="approval-allow-once"
                onClick={() => resolve('allow', 'once')}
              >
                <Trans>Consenti una volta</Trans>
              </Button>
              {/* A1: le altre scelte nel menu «Altre scelte ▾» — le STESSE
                  della card in chat, dal modello unico approvalChoicesOf.
                  Il bottone lo disegna il pezzo (buttonVariants: le classi di
                  Button) sul trigger del menu, che resta il suo <button> vero */}
              {choices.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    data-testid="approval-altre-scelte"
                    className={buttonVariants({ variant: 'secondary' })}
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
              <Button
                variant="destructive"
                data-testid="approval-deny"
                onClick={() => resolve('deny', 'once')}
              >
                <Trans>Rifiuta</Trans>
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            data-testid="approval-snooze"
            title={i18n.t(msg`Sparisce da qui per un'ora; resta in attesa nel bot`)}
            onClick={() => snooze(r.approvalId)}
          >
            <Trans>Rimanda</Trans>
          </Button>
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
  const count = g.kind === 'squad' ? i18n.t(msg`team · ${g.rows.length}`) : i18n.t(msg`bot · ${g.rows.length}`)
  return (
    // la regione col nome del gruppo (il nome accessibile di oggi) avvolge la
    // sezione: Section non prende un'aria-label, e il gruppo resta una regione con un nome
    <div
      role="region"
      aria-label={g.kind === 'squad' ? g.squad!.name : g.bot!.botName}
      data-testid="approvals-center-group"
    >
      <Section
        // lo spazio vero ({' '}) prima del contatore: il nome del gruppo e il conteggio si leggono come due parole, anche allo screen reader
        title={<>{g.kind === 'squad' ? g.squad!.name : g.bot!.botName}{' '}<span className="ml-1.5">{count}</span></>}
        action={g.kind === 'squad' ? (
          <Button variant="ghost" size="sm" onClick={() => { openGroup(g.squad!.id); setApprovalsOpen(false) }}>
            <Trans>Apri il team</Trans>
            <ChevronRight className="size-4" />
          </Button>
        ) : undefined}
      >
        {shown.map((r) => <CenterCard key={`${r.agentId}:${r.approvalId}`} r={r} now={now} />)}
        {hidden.map((h) => (
          // la riga quieta delle altre: alta 40 (come le righe di solo testo), col bottone «Vedi» dentro
          <div key={h.category} className="flex items-center justify-between gap-3 rounded-surface bg-muted/50 py-1 pl-4 pr-1">
            <span className="min-w-0 flex-1 truncate text-body text-muted-foreground">
              +{h.rows.length} {h.rows[0]!.phrase.replace(/\.$/, '').slice(0, 60)}{h.rows[0]!.phrase.length > 60 ? '…' : ''}, <Trans>di {h.rows[0]!.botName}</Trans>
            </span>
            <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => ({ ...v, [h.category]: true }))}>
              <Trans>Vedi</Trans>
            </Button>
          </div>
        ))}
      </Section>
    </div>
  )
}

/** i dati iniziali del Registro (nei test senza effect; nel prodotto si caricano dall'api) */
export interface RegistroInitial {
  log?: ApprovalLogRow[]
  grants?: GrantLike[]
}

export function ApprovalsCenter({ registroInitial }: { registroInitial?: RegistroInitial } = {}) {
  const { i18n, t } = useLingui()
  const approvalsAll = useStore((s) => s.approvalsAll)
  const approvalsSnoozed = useStore((s) => s.approvalsSnoozed)
  const approvalsFocusId = useStore((s) => s.approvalsFocusId)
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  // A2 (fase approvazioni-chiare): le due schede del centro — le richieste in
  // attesa e il REGISTRO delle decisioni (con «Consentiti sempre»)
  const approvalsView = useStore((s) => s.approvalsView)
  const setApprovalsView = useStore((s) => s.setApprovalsView)
  const [filter, setFilter] = useState<'all' | 'dati-tuoi' | 'invio' | 'sito-interattivo'>('all')
  // C3 (fase linguaggio): lo stato del REGISTRO sta QUI (i filtri stanno nella
  // barra, che è del centro): il log e i consensi si caricano pigri, quando
  // la vista registro apre — come prima, che li caricava la vista sua
  const [registroFilter, setRegistroFilter] = useState<'all' | 'approve' | 'deny' | 'expired' | 'auto'>('all')
  const [log, setLog] = useState<ApprovalLogRow[] | null>(registroInitial?.log ?? null)
  const [grants, setGrants] = useState<GrantLike[] | null>(registroInitial?.grants ?? null)
  const registroCounts = (id: 'all' | 'approve' | 'deny' | 'expired' | 'auto'): number => registroModel(log ?? [], id).length
  const reloadRegistro = (): void => {
    void api.approvalsLog(200).then(setLog).catch(() => setLog([]))
    void api.grantsList().then(setGrants).catch(() => setGrants([]))
  }
  useEffect(() => {
    if (approvalsView === 'registro' && log === null) reloadRegistro()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalsView])
  const now = Date.now()
  const rows = visibleApprovalsRows(approvalsAll, approvalsSnoozed, now)
  const counts = approvalsFilterCounts(rows)
  const filtered = filter === 'all' ? rows : rows.filter((r) => r.category === filter)
  const grouped = groupApprovalsRows(filtered)
  const bots = new Set(rows.map((r) => r.botId)).size
  const registro = approvalsView === 'registro'

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
    // la regione «Da approvare» (il nome accessibile di oggi) avvolge il guscio
    <section aria-label={i18n.t(msg`Da approvare`)}>
      <PageShell
        // le richieste stanno in una pagina (880); il Registro è una tabella: wide (1120)
        width="wide"
        z={20}
        testId="approvals-center"
        header={
          <PageHeader
            title={i18n.t(msg`Da approvare`)}
            icon={<ShieldCheck className="size-5" />}
            back={{ onClick: () => setApprovalsOpen(false), label: t`Chiudi`, testId: 'approvals-center-close' }}
            description={registro ? undefined : rows.length > 0
              ? <Trans>{rows.length} richieste da {bots} bot · solo tu puoi deciderle · ogni richiesta si decide anche dove è nata</Trans>
              : <Trans>Nessuna richiesta in attesa.</Trans>}
            actions={registro ? undefined : (
              // A2: «Registro di oggi» porta al REGISTRO del centro (prima ad
              // Attività, che delle approvazioni non sapeva nulla).
              // no-drag: sta nella fascia di trascinamento della testata
              <Button variant="secondary" size="sm" className="no-drag" data-testid="approvals-open-registro" onClick={() => setApprovalsView('registro')}>
                <Trans>Registro di oggi</Trans>
              </Button>
            )}
          />
        }
        toolbar={
          <>
            {/* A2: le due schede del centro */}
            <UnderlineTabs<ApprovalsView>
              tabs={[['richieste', i18n.t(msg`Richieste`)], ['registro', i18n.t(msg`Registro`)]]}
              value={approvalsView}
              onChange={setApprovalsView}
              testId="approvals-center-tabs"
              tabTestId={(id) => `approvals-tab-${id}`}
              className="min-w-0 flex-1"
            />
            {/* C3: i filtri dal corpo alla BARRA (richieste per tipo, registro per esito) */}
            <div className="flex min-w-0 items-center gap-2 pl-3" role="group" aria-label={registro ? i18n.t(msg`Filtra il registro`) : i18n.t(msg`Filtra per tipo`)} data-testid="approvals-filters">
              {registro ? (
                <>
                  <FilterChipsScelta active={registroFilter === 'all'} onSelect={() => setRegistroFilter('all')}><Trans>Tutte</Trans></FilterChipsScelta>
                  {REGISTRO_FILTERS.map((f) => registroCounts(f.id) > 0 && (
                    <FilterChipsScelta key={f.id} active={registroFilter === f.id} count={registroCounts(f.id)} onSelect={() => setRegistroFilter(f.id)}>{i18n.t(f.label)}</FilterChipsScelta>
                  ))}
                </>
              ) : (
                <>
                  <FilterChipsScelta active={filter === 'all'} count={rows.length} onSelect={() => setFilter('all')}><Trans>Tutte</Trans></FilterChipsScelta>
                  {APPROVALS_FILTERS.map((f) => counts[f.id] > 0 && (
                    <FilterChipsScelta key={f.id} active={filter === f.id} count={counts[f.id]} onSelect={() => setFilter(f.id)}>{i18n.t(f.label)}</FilterChipsScelta>
                  ))}
                </>
              )}
            </div>
          </>
        }
        contentClassName="flex flex-col gap-section pt-4 pb-6"
      >
        {registro ? (
          <RegistroView log={log} grants={grants} filter={registroFilter} reload={reloadRegistro} />
        ) : (
          <>
            {grouped.map((g) => <GroupSection key={g.kind === 'squad' ? `s${g.squad!.id}` : `b${g.bot!.botId}`} g={g} now={now} />)}
            {/* la rassicurazione in fondo all'elenco: l'azione «Registro di oggi» sta in testata */}
            <div className="flex items-center gap-3 rounded-surface bg-muted/50 p-4">
              <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
              <p className="text-small text-muted-foreground"><Trans>Nessuna richiesta di dati tuoi, pagamenti o invii passa senza di te.</Trans></p>
            </div>
          </>
        )}
      </PageShell>
    </section>
  )
}

// ---- A2: il Registro — le decisioni, le passate da sole, i consentiti sempre ----

/** il registro: le righe per giorno e «Consentiti sempre» con Revoca. Lo stato (log, filtri) sta nel centro: i filtri stanno nella SUA barra. */
function RegistroView({ log, grants, filter, reload }: {
  log: ApprovalLogRow[] | null
  grants: GrantLike[] | null
  filter: 'all' | 'approve' | 'deny' | 'expired' | 'auto'
  reload(): void
}): ReactNode {
  const { i18n, t } = useLingui()
  const agents = useStore((s) => s.agents)
  const lang = i18n.locale === 'en' ? 'en' : 'it'
  const rows = registroModel(log ?? [], filter)
  const days = groupRegistroByDay(rows, Date.now(), lang)

  // Fase design (DS4): la tabella unica (DataTable). QUANDO l'ora e da dove
  // è arrivata la decisione (due righe: l'ora, sotto il «da dove»), BOT e COSA
  // su una riga, troncate col testo intero al passaggio, ESITO la scelta e
  // sotto il suo dominio (la grant, il sito). COSA ed ESITO crescono e si
  // dividono lo spazio che resta: alla finestra più stretta (900 px: 776 di
  // contenuto) le due fisse e i due minimi ci stanno — 128 + 160 + 160 + 160 —
  // e sotto quella misura la tabella scorre dentro se stessa.
  const columns: ReadonlyArray<DataTableColumn<RegistroRow>> = [
    { id: 'quando', header: <Trans>Quando</Trans>, cell: (r) => <CellStack primary={r.time} secondary={r.legacy || r.viaLabel === null ? undefined : i18n.t(r.viaLabel)} /> },
    { id: 'bot', header: <Trans>Bot</Trans>, width: 160, cell: (r) => <Cell>{r.botName}</Cell> },
    { id: 'cosa', header: <Trans>Cosa</Trans>, grow: true, cell: (r) => <Cell>{r.phrase || r.tool}</Cell> },
    {
      id: 'esito',
      header: <Trans>Esito</Trans>,
      grow: true,
      // il rifiutato e lo scaduto sono grigi: non sono scelte che valgono
      cell: (r) => {
        const esito = (
          <CellStack
            primary={r.legacy ? <Trans>decisione precedente al registro</Trans> : r.choice ? i18n.t(r.choice) : r.tool}
            secondary={r.choiceDomain ?? undefined}
          />
        )
        return r.decision === 'deny' || r.decision === 'expired' ? <span className="text-muted-foreground">{esito}</span> : esito
      }
    }
  ]

  return (
    <div className="flex flex-col gap-section" data-testid="approvals-registro">
      {log === null && <p className="text-small text-muted-foreground"><Trans>caricamento…</Trans></p>}
      {log !== null && rows.length === 0 && (
        <p className="text-small text-muted-foreground"><Trans>Nessuna decisione registrata.</Trans></p>
      )}
      {days.map((d) => (
        // il giorno è l'indice della tabella: «oggi», «ieri», la data (l'iniziale in maiuscolo la mette capitalize)
        <Section key={d.label} size="body" testId="approvals-registro-day" title={<span className="capitalize">{d.label}</span>}>
          <DataTable columns={columns} rows={d.rows} rowKey={(r) => r.key} rowTestId={() => 'approvals-registro-row'} />
        </Section>
      ))}
      {/* «Consentiti sempre»: le grant attive, ciascuna con Revoca */}
      <Section size="body" testId="approvals-registro-grants" title={<Trans>Consentiti sempre</Trans>}>
        <p className="text-small text-muted-foreground"><Trans>Ciò che i bot possono fare senza chiedere. Revoca e la chiamata successiva torna a chiedere.</Trans></p>
        {grants !== null && grants.length === 0 && (
          <p className="text-small text-muted-foreground"><Trans>Nessun consenso sempre attivo.</Trans></p>
        )}
        {groupGrantsByBot(grants ?? []).map((group) => (
          // un'etichetta per bot (U7: il gruppo del bot, «Tutti i bot» per ultimo), sotto le sue concessioni a filo
          <div key={group.agentId ?? 'tutti'}>
            <h3 className="text-caption font-medium text-muted-foreground">
              {group.agentId === null
                ? <Trans>Tutti i bot</Trans>
                : agents.find((a) => a.id === group.agentId)?.name ?? group.agentId}
            </h3>
            <FlatList>
              {group.grants.map((g) => (
                <FlatRow
                  key={g.id}
                  title={<>{grantDisplayName(g, lang)}{g.tool === 'run-command' && <code className="ml-2 rounded-control bg-muted px-1.5 py-0.5 font-mono text-caption">{g.target}</code>}</>}
                  subtitle={
                    <>
                      {t`dal ${new Date(g.createdAt).toLocaleDateString()}`}
                      {g.expiresAt != null ? <> · {t`scade alle ${new Date(g.expiresAt).toLocaleTimeString()}`}</> : null}
                    </>
                  }
                  trailing={
                    <Button variant="ghost" size="sm" data-testid="grant-revoke" onClick={() => { void api.grantRevoke(g.id).then(reload).catch(() => undefined) }}>
                      <Trans>Revoca</Trans>
                    </Button>
                  }
                />
              ))}
            </FlatList>
          </div>
        ))}
      </Section>
    </div>
  )
}
