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
  const select = useStore((s) => s.select)
  const createAgent = useStore((s) => s.createAgent)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

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
        {agents.map((a) => (
          <button
            key={a.id}
            onClick={() => void select(a.id)}
            className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left ${
              a.id === activeId ? 'bg-neutral-800' : 'hover:bg-neutral-800/50'
            }`}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${statusColor[a.status]}`} title={statusLabel[a.status]} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-neutral-100">{a.name}</span>
              <span className="block truncate text-xs text-neutral-500">
                {statusLabel[a.status]}
                {a.model ? ` · ${a.model}` : ' · nessun modello'}
              </span>
            </span>
            {a.unread > 0 && (
              <span className="rounded-full bg-sky-600 px-1.5 text-xs text-white">{a.unread}</span>
            )}
          </button>
        ))}
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
