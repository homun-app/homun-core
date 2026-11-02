// Fase 16c (C5): l'Attività globale (tavola 4, sinistra) — una vista che
// occupa l'area centrale come la Libreria, aperta dalla voce «Attività» della
// barra (sopra Libreria). In alto Cerca e le pillole Tutti · Da te · Routine ·
// Non riusciti; righe senza bordo con mascotte, nome del bot nel suo colore,
// stato, titolo ed esito. Il clic apre la chat del bot sul lavoro (openTask
// per i task) o vicino al suo turno (routine). Il ‹ torna alla chat.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Search, ChevronLeft } from 'lucide-react'
import { api, useStore } from '../store'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
import { activityRows, type ActivityFilter, type ActivityRow } from '../lib/activity-rows'
import type { GlobalActivityData } from '../../../shared/types'

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
  return (
    <button
      className="flex w-full flex-col gap-1 rounded-[14px] px-2.5 py-2.5 text-left transition hover:bg-muted/60"
      onClick={() => onOpen(row)}
    >
      <span className="flex items-center gap-2">
        <Bot family={info.avatar.family} color={info.avatar.color} state={alive ? state : 'idle'} size={22} track={false} dimmed={info.dimmed} />
        <strong className="text-sm" style={{ color: `var(--bot-${info.avatar.color})` }}>{agent.name}</strong>
        {row.routine && <span className="text-xs text-muted-foreground">· <Trans>routine</Trans></span>}
        <span className="flex-1" />
        <span className={`text-xs ${statusCls}`}>{statusText}</span>
      </span>
      {(row.kind === 'waiting' ? <Trans>ti aspetta</Trans> : row.title) !== '' && (
        <span className="text-sm text-foreground/80">{row.kind === 'waiting' ? <Trans>ha bisogno di te</Trans> : row.title}</span>
      )}
      {row.status === 'done' && row.summary && (
        <span className="line-clamp-1 text-xs text-muted-foreground">{row.summary}</span>
      )}
    </button>
  )
}

export function ActivityPanel() {
  const { t, i18n } = useLingui()
  const activityOpen = useStore((s) => s.activityOpen)
  const setActivityOpen = useStore((s) => s.setActivityOpen)
  const select = useStore((s) => s.select)
  const openTask = useStore((s) => s.openTask)
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [query, setQuery] = useState('')
  const [data, setData] = useState<GlobalActivityData | null>(null)
  const load = (): void => {
    void api.activityGlobal(300).then(setData).catch(() => setData({ tasks: [], runs: [], waiting: [] }))
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

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background px-8 py-6">
      {/* la testa della vista: ‹ Attività, la ricerca e le pillole (tavola 4) */}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <div className="flex items-center gap-2">
          <button
            className="grid size-8 place-items-center rounded-[10px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label={t`Torna alla chat`}
            onClick={() => setActivityOpen(false)}
          >
            <ChevronLeft className="size-4" />
          </button>
          <h1 className="font-display text-2xl"><Trans>Attività</Trans></h1>
        </div>
        <label className="flex h-10 items-center gap-2.5 rounded-full bg-muted px-4 text-sm text-muted-foreground">
          <Search className="size-4 shrink-0" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
            placeholder={t`Cerca nei lavori`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(FILTER_LABELS) as ActivityFilter[]).map((f) => (
            <button
              key={f}
              className={`h-8 rounded-full px-3.5 text-[13px] transition ${filter === f ? 'bg-foreground text-background' : 'bg-muted text-foreground hover:bg-accent'}`}
              onClick={() => setFilter(f)}
            >
              {i18n.t(FILTER_LABELS[f])}
            </button>
          ))}
        </div>
      </div>
      <div className="mx-auto mt-4 w-full max-w-3xl flex-1 overflow-y-auto scroll-thin">
        {data === null ? (
          <p className="text-sm text-muted-foreground"><Trans>caricamento…</Trans></p>
        ) : rows.length === 0 ? (
          <p className="px-2 pt-10 text-center text-sm text-muted-foreground">
            <Trans>Nessun lavoro qui: i compiti dei bot e le loro routine finiscono in questo elenco.</Trans>
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {rows.map((row) => <ActivityListRow key={row.key} row={row} onOpen={open} />)}
          </div>
        )}
      </div>
    </div>
  )
}
