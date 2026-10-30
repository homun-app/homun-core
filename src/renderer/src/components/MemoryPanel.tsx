// Sezione "Memoria" della vista dell'agente (fase 4, §3bis L6): elenca le
// memorie del bot (scope agente) e quelle condivise (scope utente) con tier,
// data e sorgente; l'utente può modificarne il contenuto o eliminarle.
import { useEffect, useState } from 'react'
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { formatDate } from '../lib/i18n'
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
    <div className="mx-6 mt-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground"><Trans>🗂 Memoria di questo bot</Trans></h2>
        <button className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>✕</button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>Fatti e regole che il bot ricorda tra i turni. Scope "utente" = condivisi da tutti i bot.</Trans>
      </p>
      {loading && <p className="mt-2 text-xs text-muted-foreground">…</p>}
      {!loading && memories.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground"><Trans>Nessuna memoria: chiedi al bot di ricordare una preferenza.</Trans></p>
      )}
      <div className="mt-2 space-y-2">
        {memories.map((m) => (
          <div key={m.id} className="rounded-lg border border-border bg-muted px-3 py-2">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className={`rounded px-1.5 py-0.5 ${m.scope === 'user' ? 'bg-primary/15 text-primary' : 'bg-muted text-foreground'}`}>
                {m.scope === 'user' ? <Trans>utente (condivisa)</Trans> : <Trans>agente</Trans>}
              </span>
              <span className={`rounded px-1.5 py-0.5 ${m.tier === 'core' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground'}`}>
                {m.tier}
              </span>
              <span><Trans>da {m.source}</Trans></span>
              <span className="flex-1" />
              <span title={formatDate(m.updatedAt)}>{formatDate(m.updatedAt, { year: 'numeric', month: 'numeric', day: 'numeric' })}</span>
            </div>
            {editing === m.id ? (
              <div className="mt-2 space-y-2">
                <textarea
                  className="min-h-[60px] w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={Math.min(8, draft.split('\n').length)}
                />
                <div className="flex gap-2">
                  <button className="rounded-lg bg-primary px-2.5 py-1 text-xs text-white hover:bg-primary/90" onClick={() => save(m.id)}><Trans>Salva</Trans></button>
                  <button className="rounded-lg bg-accent px-2.5 py-1 text-xs text-foreground hover:bg-muted-foreground/40" onClick={() => setEditing(null)}><Trans>Annulla</Trans></button>
                </div>
              </div>
            ) : (
              <div className="group mt-1">
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">{m.content}</p>
                <div className="mt-1 hidden gap-2 text-[11px] group-hover:flex">
                  <button
                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => { setEditing(m.id); setDraft(m.content) }}
                  >
                    <Trans>Modifica</Trans>
                  </button>
                  <button className="text-destructive/80 underline-offset-2 hover:text-red-300 hover:underline" onClick={() => remove(m.id)}>
                    <Trans>Elimina</Trans>
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
