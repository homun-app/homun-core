// Fase 16c (C5): l'Attività globale (tavola 4, sinistra) — una vista che
// occupa l'area centrale come la Libreria, aperta dalla voce «Attività» della
// barra (sopra Libreria). In alto Cerca e le pillole Tutti · Da te · Routine ·
// Non riusciti; righe senza bordo con mascotte, nome del bot nel suo colore,
// stato, titolo ed esito. Il clic apre la chat del bot sul lavoro (openTask
// per i task) o vicino al suo turno (routine). Il ‹ torna alla chat.
//
// Fase design (DS4): la vista è fatta coi PEZZI di DS2. Il guscio è PageShell,
// largo wide (1120: è un elenco da leggere per colonne), con la testata
// PageHeader (indietro, l'icona, il titolo); ricerca e filtri stanno nel
// toolbar, FERMI sopra il corpo che scorre. Le righe sono dentro FlatList e
// hanno le misure della riga di elenco di DS1 — le stesse di FlatRow: lo slot
// da 32, il respiro di 12, 12 fra la mascotte e il testo — ma sono scritte
// qui, perché hanno TRE righe di testo (nome e stato, titolo, esito) e
// FlatRow ne ha due. Il leading è la mascotte del bot, il suo «logo»: 32 px,
// come i loghi nelle righe, e sta sul rigo del nome (sotto ci possono essere
// due righe: centrato sul blocco finirebbe accanto al titolo).
// `activityInitial` è per i test senza effect (come registroInitial del
// centro): nel prodotto i dati arrivano dall'api.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Activity } from 'lucide-react'
import { api, useStore } from '../store'
import { Bot } from '../bot/Bot'
// C3 (fase linguaggio): il puntino del colore del bot (il nome resta nel colore del testo)
import { BotDot } from './ui/bot-dot'
import { useBotInfo } from '../bot/use-bot'
import { activityRows, type ActivityFilter, type ActivityRow } from '../lib/activity-rows'
import { cn } from '../lib/utils'
import type { GlobalActivityData } from '../../../shared/types'
import { Button } from './ui/button'
import { SearchField } from './ui/search-field'
import { FilterChipsScelta } from './ui/filter-chips'
import { FlatList } from './ui/flat-list'
import { PageHeader } from './ui/page-header'
import { PageShell } from './ui/page-shell'

const FILTER_LABELS: Record<ActivityFilter, MessageDescriptor> = {
  all: msg`Tutti`,
  mine: msg`Da te`,
  routines: msg`Routine`,
  failed: msg`Non riusciti`
}

/** Il motivo di un fallimento in parole (mai il testo grezzo del provider). */
const REASON_LABELS: Record<string, MessageDescriptor> = {
  credit: msg`modello senza credito`,
  'not-responding': msg`modello che non risponde`,
  'rate-limit': msg`limite d'uso`,
  cancelled: msg`annullato`,
  other: msg`non riuscito`
}

/** L'ora breve di una riga finita (9:00 · ieri · 2 giorni fa). */
function relativeDay(at: number, lang: 'it' | 'en'): string {
  if (!at) return ''
  const d = new Date(at)
  const now = new Date()
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000)
  const time = d.toLocaleTimeString(lang === 'en' ? 'en' : 'it', { hour: '2-digit', minute: '2-digit' })
  if (days === 0) return time
  if (days === 1) return lang === 'en' ? `yesterday ${time}` : `ieri ${time}`
  return `${days} d`
}

/** Una riga dell'Attività: mascotte (viva se lavora), nome, stato, titolo, esito. */
function ActivityListRow({ row, onOpen }: { row: ActivityRow; onOpen(row: ActivityRow): void }) {
  const { i18n } = useLingui()
  const agents = useStore((s) => s.agents)
  const agent = agents.find((a) => a.id === row.agentId)
  const info = useBotInfo(row.agentId)
  const lang = i18n.locale === 'en' ? 'en' : 'it'
  const alive = row.status === 'running' || row.status === 'waiting'
  const state = row.status === 'running' || row.status === 'waiting'
    ? (info?.state === 'thinking' || info?.state === 'speaking' || info?.state === 'listening' ? info.state : 'thinking')
    : 'idle'
  const statusText: string = (() => {
    switch (row.status) {
      case 'running': return i18n._(msg`in corso`)
      case 'waiting': return i18n._(msg`aspetta te`)
      case 'done': return `${relativeDay(row.at, lang)} ✓`
      case 'failed': return i18n.t(REASON_LABELS[row.reason ?? 'other']!)
      case 'cancelled': return i18n._(msg`annullato`)
    }
  })()
  const statusCls = row.status === 'running' ? 'text-muted-foreground'
    : row.status === 'waiting' ? 'text-waiting font-semibold'
      : row.status === 'failed' ? 'text-destructive'
        : 'text-muted-foreground'
  if (!agent || !info) return null
  // la riga di sotto: chi aspetta te lo dice al posto del titolo (che non ha)
  const conTitolo = row.kind === 'waiting' || row.title !== ''
  return (
    // un <button> e non un FlatRow cliccabile: dentro non ci sono controlli, e il tasto vero è quello che si aspetta la tastiera
    <button
      type="button"
      className="flex w-full cursor-pointer items-start gap-row-gap py-row-pad text-left transition hover:bg-muted/50"
      onClick={() => onOpen(row)}
    >
      {/* -mt-1.5: lo slot (32) centrato sul rigo del nome (20), non sul blocco */}
      <span className="-mt-1.5 grid size-8 shrink-0 place-items-center">
        <Bot family={info.avatar.family} color={info.avatar.color} state={alive ? state : 'idle'} size={32} track={false} dimmed={info.dimmed} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {/* C3 (fase linguaggio): il nome del bot nel COLORE DEL TESTO — il colore del bot sta nel puntino (BotDot, la palette --bot-dot-*) */}
          <BotDot color={info.avatar.color} />
          <span className="truncate text-body font-medium">{agent.name}</span>
          {row.routine && <span className="shrink-0 text-small text-muted-foreground">· <Trans>routine</Trans></span>}
          <span className="flex-1" />
          {/* lo stato non va a capo: cede il nome */}
          <span className={`shrink-0 whitespace-nowrap text-caption ${statusCls}`}>{statusText}</span>
        </span>
        {conTitolo && (
          <span className="mt-0.5 block truncate text-body">{row.kind === 'waiting' ? <Trans>ha bisogno di te</Trans> : row.title}</span>
        )}
        {row.status === 'done' && row.summary && (
          <span className="mt-0.5 block truncate text-small text-muted-foreground">{row.summary}</span>
        )}
      </span>
    </button>
  )
}

export function ActivityPanel({ activityInitial }: { activityInitial?: GlobalActivityData } = {}) {
  const { t, i18n } = useLingui()
  const activityOpen = useStore((s) => s.activityOpen)
  const setActivityOpen = useStore((s) => s.setActivityOpen)
  const select = useStore((s) => s.select)
  const openTask = useStore((s) => s.openTask)
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [query, setQuery] = useState('')
  const [data, setData] = useState<GlobalActivityData | null>(activityInitial ?? null)
  // fase 16c correzioni (R1): un RPC che fallisce non è «nessun lavoro» —
  // si mostra una riga d'errore con Riprova, mai lo stato vuoto in silenzio
  const [failed, setFailed] = useState(false)
  const load = (): void => {
    void api.activityGlobal(300).then((d) => { setData(d); setFailed(false) }).catch(() => setFailed(true))
  }
  useEffect(() => {
    if (!activityOpen) return
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [activityOpen])

  if (!activityOpen) return null
  const rows = data ? activityRows(data, filter, query) : []

  const open = (row: ActivityRow): void => {
    void select(row.agentId)
    if (row.taskId !== null) openTask(row.taskId)
    setActivityOpen(false)
  }

  // il guscio è no-drag (PageShell): la vista sta SOPRA la fascia di
  // trascinamento della chat, che Electron calcola ignorando lo z-index —
  // senza, la freccia ‹ in alto cade dentro la fascia e il clic trascina la finestra
  return (
    <PageShell
      width="wide"
      z={20}
      testId="activity-panel"
      header={
        <PageHeader
          title={t`Attività`}
          icon={<Activity className="size-5" />}
          back={{ onClick: () => setActivityOpen(false), label: t`Torna alla chat` }}
        />
      }
      toolbar={
        <>
          {/* C3 (fase linguaggio): la ricerca è SearchField, l'unica dell'app */}
          <SearchField value={query} onChange={setQuery} placeholder={t`Cerca nei lavori`} ariaLabel={t`Cerca nei lavori`} testId="activity-search" className="min-w-0 flex-1" />
          {/* i filtri (tavolo 4): pillole, una sola accesa — tutte pillole, la forma non cambia con lo stato.
              min-w-0 e non shrink-0: in un'area stretta (finestra a 900 px col pannello del bot aperto)
              le pillole cedono spazio e vanno a capo, invece di spingersi sotto il pannello; la ricerca
              (flex-1) prende ciò che resta */}
          {/* C4/C3: i filtri sono le pillole del catalogo (FilterChipsScelta) */}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {(Object.keys(FILTER_LABELS) as ActivityFilter[]).map((f) => (
              <FilterChipsScelta key={f} active={filter === f} onSelect={() => setFilter(f)}>
                {i18n.t(FILTER_LABELS[f])}
              </FilterChipsScelta>
            ))}
          </div>
        </>
      }
      contentClassName="flex flex-col gap-section pt-2 pb-6"
    >
      {/* fase 16c correzioni (R1): un RPC fallito non è «nessun lavoro» —
          riga d'errore in parole con Riprova, mai lo stato vuoto in silenzio */}
      {failed && (
        <div className={cn('flex items-center gap-3 text-body text-muted-foreground', data ? '' : 'justify-center pt-10')}>
          <Trans>Non riesco a leggere le attività</Trans>
          <Button variant="ghost" size="sm" onClick={load}><Trans>Riprova</Trans></Button>
        </div>
      )}
      {!failed && data === null ? (
        <p className="text-small text-muted-foreground"><Trans>caricamento…</Trans></p>
      ) : data !== null && rows.length === 0 ? (
        <p className="pt-10 text-center text-body text-muted-foreground">
          <Trans>Nessun lavoro qui: i compiti dei bot e le loro routine finiscono in questo elenco.</Trans>
        </p>
      ) : data !== null ? (
        <FlatList>
          {rows.map((row) => <ActivityListRow key={row.key} row={row} onOpen={open} />)}
        </FlatList>
      ) : null}
    </PageShell>
  )
}
