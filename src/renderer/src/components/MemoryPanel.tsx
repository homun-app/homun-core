// Sezione "Memoria" della vista dell'agente (fase 4, §3bis L6): elenca le
// memorie del bot (scope agente) e quelle condivise (scope utente) con tier,
// data e sorgente; l'utente può modificarne il contenuto o eliminarle.
import { useEffect, useState } from 'react'
import { api } from '../store'
import type { MemoryInfo } from '../../../shared/types'

export function MemoryPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const [memories, setMemories] = useState<MemoryInfo[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)

  const reload = () => {
    setLoading(true)
    void api.listMemories(agentId).then((ms) => setMemories(ms)).finally(() => setLoading(false))
  }
  useEffect(reload, [agentId])

  const save = (id: string) => {
    void api.updateMemory(agentId, id, draft).then(() => {
      setEditing(null)
      reload()
    })
  }
  const remove = (id: string) => {
    void api.deleteMemory(agentId, id).then(reload)
  }

  return (
    <div className="mx-6 mt-3 rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-200">🗂 Memoria di questo bot</h2>
        <button className="rounded-md px-2 py-0.5 text-xs text-neutral-500 hover:text-neutral-200" onClick={onClose}>✕</button>
      </div>
      <p className="mt-1 text-xs text-neutral-600">
        Fatti e regole che il bot ricorda tra i turni. Scope "utente" = condivisi da tutti i bot.
      </p>
      {loading && <p className="mt-2 text-xs text-neutral-500">…</p>}
      {!loading && memories.length === 0 && (
        <p className="mt-2 text-xs text-neutral-600">Nessuna memoria: chiedi al bot di ricordare una preferenza.</p>
      )}
      <div className="mt-2 space-y-2">
        {memories.map((m) => (
          <div key={m.id} className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
            <div className="flex items-center gap-2 text-[11px] text-neutral-500">
              <span className={`rounded px-1.5 py-0.5 ${m.scope === 'user' ? 'bg-sky-900/60 text-sky-300' : 'bg-neutral-800 text-neutral-300'}`}>
                {m.scope === 'user' ? 'utente (condivisa)' : 'agente'}
              </span>
              <span className={`rounded px-1.5 py-0.5 ${m.tier === 'core' ? 'bg-amber-900/50 text-amber-300' : 'bg-neutral-800 text-neutral-400'}`}>
                {m.tier}
              </span>
              <span>da {m.source}</span>
              <span className="flex-1" />
              <span title={new Date(m.updatedAt).toLocaleString()}>{new Date(m.updatedAt).toLocaleDateString()}</span>
            </div>
            {editing === m.id ? (
              <div className="mt-2 space-y-2">
                <textarea
                  className="min-h-[60px] w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-200 outline-none"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={Math.min(8, draft.split('\n').length)}
                />
                <div className="flex gap-2">
                  <button className="rounded-lg bg-sky-600 px-2.5 py-1 text-xs text-white hover:bg-sky-500" onClick={() => save(m.id)}>Salva</button>
                  <button className="rounded-lg bg-neutral-700 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-600" onClick={() => setEditing(null)}>Annulla</button>
                </div>
              </div>
            ) : (
              <div className="group mt-1">
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-300">{m.content}</p>
                <div className="mt-1 hidden gap-2 text-[11px] group-hover:flex">
                  <button
                    className="text-neutral-400 underline-offset-2 hover:text-neutral-100 hover:underline"
                    onClick={() => { setEditing(m.id); setDraft(m.content) }}
                  >
                    Modifica
                  </button>
                  <button className="text-red-400/80 underline-offset-2 hover:text-red-300 hover:underline" onClick={() => remove(m.id)}>
                    Elimina
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
