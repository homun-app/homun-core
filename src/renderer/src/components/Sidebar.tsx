import { useState } from 'react'
import { useStore } from '../store'
import type { AgentStatus } from '../../../shared/types'

const statusColor: Record<AgentStatus, string> = {
  offline: 'bg-neutral-600',
  idle: 'bg-emerald-500',
  thinking: 'bg-amber-400 animate-pulse',
  running: 'bg-sky-400 animate-pulse',
  'paused-for-approval': 'bg-orange-500 animate-pulse'
}

const statusLabel: Record<AgentStatus, string> = {
  offline: 'Offline',
  idle: 'Online',
  thinking: 'Thinking',
  running: 'Running',
  'paused-for-approval': 'In attesa di approvazione'
}

export function Sidebar() {
  const agents = useStore((s) => s.agents)
  const activeId = useStore((s) => s.activeId)
  const mainAgentId = useStore((s) => s.mainAgentId)
  // fase 8 (§3bis L7): stato live (tool in corso) e task in corso per agente
  const activity = useStore((s) => s.activity)
  const tasks = useStore((s) => s.tasks)
  // fase 10: i gruppi della sidebar e la vista gruppo aperta
  const groups = useStore((s) => s.groups)
  // fase 12: i sottoagenti (stato live del padre: N al lavoro)
  const subagents = useStore((s) => s.subagents)
  const openGroupId = useStore((s) => s.openGroupId)
  const openGroup = useStore((s) => s.openGroup)
  const openLibraryId = useStore((s) => s.openLibraryId)
  const openLibrary = useStore((s) => s.openLibrary)
  const select = useStore((s) => s.select)
  const createAgent = useStore((s) => s.createAgent)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  // fase 7: senza setting mainAgentId il principale è il primo agente (il più vecchio)
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const workingTasksOf = (agentId: string): number => tasks.filter((t) => t.agentId === agentId && t.status === 'working').length
  const subagentsOf = (agentId: string): { running: number } => ({
    running: subagents.filter((x) => x.parentId === agentId && x.status === 'running').length
  })

  const agentButton = (a: (typeof agents)[number]) => (
    <button
      key={a.id}
      onClick={() => void select(a.id)}
      className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left ${
        a.id === activeId && openGroupId === null ? 'bg-neutral-800' : 'hover:bg-neutral-800/50'
      }`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${statusColor[a.status]}`} title={statusLabel[a.status]} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm text-neutral-100">{a.name}</span>
          {a.id === effectiveMain && (
            <span className="shrink-0 rounded bg-sky-800/60 px-1.5 py-0.5 text-[10px] font-medium text-sky-200" title="Bot principale: coordina gli altri bot">
              ★ principale
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-neutral-500">
          {statusLabel[a.status]}
          {a.model ? ` · ${a.model}` : ' · nessun modello'}
          {workingTasksOf(a.id) > 0 ? ` · ${workingTasksOf(a.id)} task` : ''}
        </span>
        {/* fase 8 (§3bis L7): stato live — nome del tool e target, mai testo del modello */}
        {/* fase 12: stato live del padre — figli al lavoro (has_running_subagents di Grok) */}
        {subagentsOf(a.id).running > 0 && (
          <span className="block truncate text-[10px] text-teal-400/80">
            {subagentsOf(a.id).running} sottoagenti al lavoro
          </span>
        )}
        {activity[a.id] && (
          <span className="block truncate text-[10px] text-sky-400/80" title={`${activity[a.id]!.tool} ${activity[a.id]!.target}`}>
            sta facendo {activity[a.id]!.tool}
            {activity[a.id]!.target ? ` · ${activity[a.id]!.target}` : ''}…
          </span>
        )}
      </span>
      {a.unread > 0 && (
        <span className="rounded-full bg-sky-600 px-1.5 text-xs text-white">{a.unread}</span>
      )}
    </button>
  )

  // fase 10: i bot senza sezione stanno insieme; quelli con sezione sotto il
  // suo titolo (l'ordine delle sezioni è di creazione)
  const noSection = agents.filter((a) => !a.section)
  const sections = [...new Set(agents.map((a) => a.section).filter((s): s is string => !!s))]

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/60">
      <div className="flex items-center justify-between px-3 pt-10 pb-2">
        <span className="text-sm font-semibold tracking-wide text-neutral-200">SandBot</span>
        <button
          className="rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          onClick={() => setSettingsOpen(true)}
        >
          Impostazioni
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin px-2">
        {noSection.map(agentButton)}
        {sections.map((sec) => (
          <div key={sec} className="mt-3">
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">{sec}</p>
            {agents.filter((a) => a.section === sec).map(agentButton)}
          </div>
        ))}
        {/* fase 10: i gruppi in una sezione propria (vista gruppo con @menzioni) */}
        {/* fase 14: la LIBRERIA dei prodotti dei bot (documenti, grafici, file) */}
        <button
          className={`w-full rounded-lg px-2 py-1.5 text-left text-sm ${openLibraryId !== null ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-800/50'}`}
          onClick={() => openLibraryId === null ? openLibrary('') : openLibrary(null)}
        >
          🗂 Libreria
        </button>
        {groups.length > 0 && (
          <div className="mt-3 border-t border-neutral-800/60 pt-2">
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">Gruppi</p>
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => openGroup(g.id)}
                className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left ${
                  g.id === openGroupId ? 'bg-neutral-800' : 'hover:bg-neutral-800/50'
                }`}
                title={g.description}
              >
                <span className="shrink-0 rounded bg-violet-800/50 px-1.5 py-0.5 text-[10px] font-medium text-violet-200">
                  {g.members.length + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-neutral-100">{g.name}</span>
                  <span className="block truncate text-xs text-neutral-500">
                    {g.members.map((m) => m.name).join(', ') || 'solo tu'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800 p-2">
        {creating ? (
          <div className="flex gap-1">
            <input
              autoFocus
              className="min-w-0 flex-1 rounded-md bg-neutral-800 px-2 py-1 text-sm outline-none"
              placeholder="Nome del bot"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) {
                  void createAgent(newName.trim())
                  setNewName('')
                  setCreating(false)
                }
                if (e.key === 'Escape') setCreating(false)
              }}
            />
          </div>
        ) : (
          <button
            className="w-full rounded-md px-2 py-1.5 text-left text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            onClick={() => setCreating(true)}
          >
            + Nuovo Bot
          </button>
        )}
      </div>
    </aside>
  )
}
