// Pannello destro (fase 16, U4): mascotte grande e tab a pillola
// Dettagli / Libreria / Attività. Con la vista gruppo aperta mostra il gruppo
// (descrizione e membri). Visibile da lg, chiudibile dal bottone
// nell'intestazione della chat (setting ui.rightPanel).
import { useEffect, useState } from 'react'
import { Star, Palette, Brain, Wrench, FileText } from 'lucide-react'
import { useStore, api } from '../store'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
import { avatarOf } from '../../../shared/avatar'
import type { LibraryItemInfo, RoutineInfo } from '../../../shared/types'
import { ChangeAvatarDialog } from './BotDialogs'

const TABS = ['Dettagli', 'Libreria', 'Attività'] as const
type Tab = (typeof TABS)[number]

const TASK_LABEL: Record<string, string> = {
  working: 'in corso',
  needs_input: 'attende te',
  done: 'completato',
  failed: 'non riuscito',
  cancelled: 'annullato'
}

function fmtTime(at: number): string {
  return new Date(at).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Dettagli: descrizione, modello, principale, Cambia aspetto, Memoria e Skill. */
function DetailsTab({ onAvatar }: { onAvatar(): void }) {
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
      <p className="text-sm">{agent.description || 'Nessuna descrizione.'}</p>
      <p className="text-xs text-muted-foreground">
        {agent.providerId ? `${agent.providerId} · ${agent.model ?? ''}` : 'configura modello → Impostazioni'}
      </p>
      {isMain ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Star className="size-3.5" /> Principale — coordina gli altri bot
        </p>
      ) : (
        <button className="rounded-lg bg-muted px-2.5 py-1.5 text-xs transition hover:bg-accent" onClick={() => void setMainAgent(agent.id)}>
          Rendi principale
        </button>
      )}
      <button className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-xs transition hover:bg-accent" onClick={onAvatar}>
        <Palette className="size-3.5" /> Cambia aspetto
      </button>
      <div className="flex gap-2 border-t border-border pt-3">
        <button
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
          title="Memoria del bot (fatti e regole ricordati)"
          onClick={() => { setMemoryOpen(true); setSkillsOpen(false) }}
        >
          <Brain className="size-3.5" /> Memoria
        </button>
        <button
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
          title="Skill del bot (procedure riutilizzabili)"
          onClick={() => { setSkillsOpen(true); setMemoryOpen(false) }}
        >
          <Wrench className="size-3.5" /> Skill
        </button>
      </div>
    </div>
  )
}

/** Libreria: i documenti prodotti da QUESTO bot, ordinati per aggiornamento. */
function LibraryTab() {
  const activeId = useStore((s) => s.activeId)
  const openLibrary = useStore((s) => s.openLibrary)
  const [items, setItems] = useState<LibraryItemInfo[] | null>(null)
  useEffect(() => {
    if (!activeId) return
    api.libraryList()
      .then((all) => setItems(all.filter((i) => i.authorAgentId === activeId).sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch(() => setItems([]))
  }, [activeId])
  if (items === null) return <p className="text-xs text-muted-foreground">caricamento…</p>
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nessun documento per ora.</p>
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
  const activeId = useStore((s) => s.activeId)
  const tasks = useStore((s) => s.tasks)
  const subagents = useStore((s) => s.subagents)
  const openTask = useStore((s) => s.openTask)
  const openSubagent = useStore((s) => s.openSubagent)
  const [routines, setRoutines] = useState<RoutineInfo[]>([])
  useEffect(() => {
    if (activeId) api.listRoutines(activeId).then(setRoutines).catch(() => setRoutines([]))
  }, [activeId])
  const myTasks = tasks.filter((t) => t.agentId === activeId).slice(-10).reverse()
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Task</p>
        {myTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessun task.</p>
        ) : (
          <div className="space-y-1.5">
            {myTasks.map((t) => (
              <button
                key={t.id}
                className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-2 text-left text-sm transition hover:border-muted-foreground"
                onClick={() => openTask(t.id)}
              >
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{TASK_LABEL[t.status] ?? t.status}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sottoagenti</p>
        {subagents.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessun sottoagente.</p>
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
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Prossime routine</p>
        {routines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessuna routine.</p>
        ) : (
          <div className="space-y-1.5">
            {routines.map((r) => (
              <div key={r.id} className="rounded-xl border border-border px-3 py-2 text-sm">
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{r.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{r.enabled ? 'attiva' : 'in pausa'}</span>
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
  const rightPanel = useStore((s) => s.rightPanel)
  const activeId = useStore((s) => s.activeId)
  const openGroupId = useStore((s) => s.openGroupId)
  const groups = useStore((s) => s.groups)
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const info = useBotInfo(activeId)
  const [tab, setTab] = useState<Tab>('Dettagli')
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
          <p className="mt-2 text-sm text-muted-foreground">{group.description || 'Nessuna descrizione.'}</p>
          <div className="mt-4 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Membri</p>
            {group.members.map((m) => {
              const a = agents.find((x) => x.id === m.agentId)
              if (!a) return null
              const av = avatarOf(a, agents, effectiveMain)
              return (
                <div key={m.agentId} className="flex items-center gap-2 text-sm">
                  <Bot family={av.family} color={av.color} state="idle" size={24} track={false} />
                  <span className="truncate">{m.name}</span>
                  {m.coordinator && <span className="text-xs text-muted-foreground">coordinatore</span>}
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
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 rounded-full py-1 text-xs transition ${tab === t ? 'bg-foreground text-background' : 'text-muted-foreground'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto scroll-thin p-5 text-sm text-muted-foreground">
            {tab === 'Dettagli' && <DetailsTab onAvatar={() => setAvatarOpen(true)} />}
            {tab === 'Libreria' && <LibraryTab />}
            {tab === 'Attività' && <ActivityTab />}
          </div>
          {avatarOpen && <ChangeAvatarDialog agentId={info.agent.id} current={info.avatar} onClose={() => setAvatarOpen(false)} />}
        </>
      ) : null}
    </aside>
  )
}
