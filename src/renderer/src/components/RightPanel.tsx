// Pannello destro (fase 16, U4): mascotte grande e tab a pillola
// Dettagli / Libreria / Attività. Con la vista gruppo aperta mostra il gruppo
// (descrizione e membri). Visibile da lg, chiudibile dal bottone
// nell'intestazione della chat (setting ui.rightPanel).
import { useEffect, useState } from 'react'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { t, msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { formatDate } from '../lib/i18n'
import { Star, Palette, Brain, Wrench, FileText } from 'lucide-react'
import { useStore, api } from '../store'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
import { avatarOf } from '../../../shared/avatar'
import type { LibraryItemInfo, RoutineInfo } from '../../../shared/types'
import { ChangeAvatarDialog } from './BotDialogs'

// fase 17a: i tab come descriptor (gli id interni non cambiano)
const TABS = [msg`Dettagli`, msg`Libreria`, msg`Attività`] as const

const TASK_LABEL: Record<string, MessageDescriptor> = {
  working: msg`in corso`,
  needs_input: msg`attende te`,
  done: msg`completato`,
  failed: msg`non riuscito`,
  cancelled: msg`annullato`
}

function fmtTime(at: number): string {
  return formatDate(at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Dettagli: descrizione, modello, principale, Cambia aspetto, Memoria e Skill. */
function DetailsTab({ onAvatar }: { onAvatar(): void }) {
  const { i18n } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const setMainAgent = useStore((s) => s.setMainAgent)
  const setMemoryOpen = useStore((s) => s.setMemoryOpen)
  const setSkillsOpen = useStore((s) => s.setSkillsOpen)
  const agent = agents.find((a) => a.id === activeId)
  if (!agent) return null
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const isMain = agent.id === effectiveMain
  return (
    <div className="space-y-3">
      <p className="text-sm">{agent.description || <Trans>Nessuna descrizione.</Trans>}</p>
      <p className="text-xs text-muted-foreground">
        {agent.providerId ? `${agent.providerId} · ${agent.model ?? ''}` : t`configura modello → Impostazioni`}
      </p>
      {isMain ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Star className="size-3.5" /> <Trans>Principale — coordina gli altri bot</Trans>
        </p>
      ) : (
        <button className="rounded-lg bg-muted px-2.5 py-1.5 text-xs transition hover:bg-accent" onClick={() => void setMainAgent(agent.id)}>
          <Trans>Rendi principale</Trans>
        </button>
      )}
      <button className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-xs transition hover:bg-accent" onClick={onAvatar}>
        <Palette className="size-3.5" /> <Trans>Cambia aspetto</Trans>
      </button>
      <div className="flex gap-2 border-t border-border pt-3">
        <button
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
          title={t`Memoria del bot (fatti e regole ricordati)`}
          onClick={() => { setMemoryOpen(true); setSkillsOpen(false) }}
        >
          <Brain className="size-3.5" /> <Trans>Memoria</Trans>
        </button>
        <button
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
          title={t`Skill del bot (procedure riutilizzabili)`}
          onClick={() => { setSkillsOpen(true); setMemoryOpen(false) }}
        >
          <Wrench className="size-3.5" /> <Trans>Skill</Trans>
        </button>
      </div>
    </div>
  )
}

/** Libreria: i documenti prodotti da QUESTO bot, ordinati per aggiornamento. */
function LibraryTab() {
  const { i18n } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const openLibrary = useStore((s) => s.openLibrary)
  const [items, setItems] = useState<LibraryItemInfo[] | null>(null)
  useEffect(() => {
    if (!activeId) return
    api.libraryList()
      .then((all) => setItems(all.filter((i) => i.authorAgentId === activeId).sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch(() => setItems([]))
  }, [activeId])
  if (items === null) return <p className="text-xs text-muted-foreground"><Trans>caricamento…</Trans></p>
  if (items.length === 0) return <p className="text-sm text-muted-foreground"><Trans>Nessun documento per ora.</Trans></p>
  return (
    <div className="space-y-1.5">
      {items.map((i) => (
        <button
          key={i.id}
          className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-2 text-left text-sm transition hover:border-muted-foreground"
          onClick={() => openLibrary(i.id)}
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{i.title}</span>
            <span className="block text-xs text-muted-foreground">{fmtTime(i.updatedAt)}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

/** Attività: task del bot (con stato), sottoagenti e prossime routine. */
function ActivityTab() {
  const { i18n } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const tasks = useStore((s) => s.tasks)
  const subagents = useStore((s) => s.subagents)
  const openTask = useStore((s) => s.openTask)
  const openSubagent = useStore((s) => s.openSubagent)
  const [routines, setRoutines] = useState<RoutineInfo[]>([])
  useEffect(() => {
    if (activeId) api.listRoutines(activeId).then(setRoutines).catch(() => setRoutines([]))
  }, [activeId])
  const myTasks = tasks.filter((tk) => tk.agentId === activeId).slice(-10).reverse()
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><Trans>Task</Trans></p>
        {myTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground"><Trans>Nessun task.</Trans></p>
        ) : (
          <div className="space-y-1.5">
            {myTasks.map((tk) => (
              <button
                key={tk.id}
                className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-2 text-left text-sm transition hover:border-muted-foreground"
                onClick={() => openTask(tk.id)}
              >
                <span className="min-w-0 flex-1 truncate">{tk.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{i18n.t(TASK_LABEL[tk.status] ?? msg`${tk.status}`)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><Trans>Sottoagenti</Trans></p>
        {subagents.length === 0 ? (
          <p className="text-sm text-muted-foreground"><Trans>Nessun sottoagente.</Trans></p>
        ) : (
          <div className="space-y-1.5">
            {subagents.map((x) => (
              <button
                key={x.id}
                className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-2 text-left text-sm transition hover:border-muted-foreground"
                onClick={() => openSubagent(x.id)}
              >
                <span className="min-w-0 flex-1 truncate">{x.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{x.status}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><Trans>Prossime routine</Trans></p>
        {routines.length === 0 ? (
          <p className="text-sm text-muted-foreground"><Trans>Nessuna routine.</Trans></p>
        ) : (
          <div className="space-y-1.5">
            {routines.map((r) => (
              <div key={r.id} className="rounded-xl border border-border px-3 py-2 text-sm">
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{r.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{r.enabled ? t`attiva` : t`in pausa`}</span>
                </span>
                {r.next_run && <span className="mt-0.5 block text-xs text-muted-foreground">{fmtTime(r.next_run)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function RightPanel() {
  const { i18n } = useLingui()
  const rightPanel = useStore((s) => s.rightPanel)
  const activeId = useStore((s) => s.activeId)
  const openGroupId = useStore((s) => s.openGroupId)
  const groups = useStore((s) => s.groups)
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const info = useBotInfo(activeId)
  const [tab, setTab] = useState(0)
  const [avatarOpen, setAvatarOpen] = useState(false)
  if (!rightPanel) return null
  const group = groups.find((g) => g.id === openGroupId)
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null

  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-border bg-card lg:flex">
      {group ? (
        // vista gruppo: descrizione e membri
        <div className="p-5">
          <h2 className="font-display text-2xl">{group.name}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{group.description || <Trans>Nessuna descrizione.</Trans>}</p>
          <div className="mt-4 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><Trans>Membri</Trans></p>
            {group.members.map((m) => {
              const a = agents.find((x) => x.id === m.agentId)
              if (!a) return null
              const av = avatarOf(a, agents, effectiveMain)
              return (
                <div key={m.agentId} className="flex items-center gap-2 text-sm">
                  <Bot family={av.family} color={av.color} state="idle" size={24} track={false} />
                  <span className="truncate">{m.name}</span>
                  {m.coordinator && <span className="text-xs text-muted-foreground"><Trans>coordinatore</Trans></span>}
                </div>
              )
            })}
          </div>
        </div>
      ) : info ? (
        <>
          <div className="grid place-items-center gap-2 px-6 pt-8 pb-5">
            <div className="grid place-items-center rounded-3xl bg-muted p-5">
              <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={130} dimmed={info.dimmed} label={info.agent.name} />
            </div>
            <h2 className="font-display text-2xl">{info.agent.name}</h2>
          </div>
          <div className="mx-4 flex gap-1 rounded-full bg-muted p-1">
            {TABS.map((tabLabel, i) => (
              <button
                key={i}
                onClick={() => setTab(i)}
                className={`flex-1 rounded-full py-1 text-xs transition ${tab === i ? 'bg-foreground text-background' : 'text-muted-foreground'}`}
              >
                {i18n.t(tabLabel)}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto scroll-thin p-5 text-sm text-muted-foreground">
            {tab === 0 && <DetailsTab onAvatar={() => setAvatarOpen(true)} />}
            {tab === 1 && <LibraryTab />}
            {tab === 2 && <ActivityTab />}
          </div>
          {avatarOpen && <ChangeAvatarDialog agentId={info.agent.id} current={info.avatar} onClose={() => setAvatarOpen(false)} />}
        </>
      ) : null}
    </aside>
  )
}
