// Card del sottoagente (fase 12, punto 7): l'unica riga del figlio nella chat
// del padre — titolo, stato live (dalla tabella subagents + stato dell'agente
// figlio: paused-for-approval = "in attesa di conferma"), tempo trascorso e i
// bottoni Apri (pannello del transcript del figlio) e Ferma. Come TaskCard, lo
// stato arriva dal registro, non dal testo del modello.
import { useStore } from '../store'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload, SubagentInfo } from '../../../shared/types'

const STATUS_LABEL: Record<SubagentInfo['status'], string> = {
  queued: 'in coda',
  running: 'al lavoro',
  done: 'finito',
  failed: 'fallito',
  stopped: 'fermato',
  expired: 'scaduto'
}
const STATUS_CLS: Record<SubagentInfo['status'], string> = {
  queued: 'text-neutral-400',
  running: 'text-sky-300',
  done: 'text-emerald-400',
  failed: 'text-red-400',
  stopped: 'text-neutral-500',
  expired: 'text-amber-400'
}

function fmtAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 3600)} h`
}

export function SubagentCard({ entry }: { entry: TranscriptEntry }) {
  const subagents = useStore((s) => s.subagents)
  const openSubagent = useStore((s) => s.openSubagent)
  const stopSubagent = useStore((s) => s.stopSubagent)
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const message = meta.message as Extract<SendMessagePayload, { type: 'subagent' }> | undefined
  if (!message) return null
  const sub = subagents.find((x) => x.id === message.subagentId)
  const now = Date.now()
  // stato live: il registro dice queued/running/…; un figlio fermo su una card
  // dell'utente è "in attesa di conferma"
  const waiting = sub?.status === 'running' && sub.agentStatus === 'paused-for-approval'
  const status = sub?.status ?? 'queued'
  const open = status === 'queued' || status === 'running'

  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-teal-800/40 bg-teal-950/10 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-teal-300/80">Sottoagente</span>
        <span className={`text-[11px] font-medium ${STATUS_CLS[status]}`}>
          {status === 'done' ? '✓' : status === 'failed' ? '⚠' : status === 'stopped' ? '⛔' : status === 'expired' ? '⏱' : '⏳'}
          {' '}{waiting ? 'in attesa di conferma' : STATUS_LABEL[status]}
        </span>
      </div>
      <p className="mt-1 text-sm text-neutral-100">{message.title}</p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-neutral-500">
          {fmtAgo(sub.startedAt ?? sub.createdAt, now)} trascorsi
          {sub.status === 'done' && sub.summary ? ` — ${sub.summary.slice(0, 120)}` : ''}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          className="rounded-lg border border-teal-500 bg-teal-700/70 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-600"
          onClick={() => openSubagent(message.subagentId)}
        >
          Apri
        </button>
        {open && (
          <button
            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700"
            onClick={() => stopSubagent(message.subagentId)}
          >
            Ferma
          </button>
        )}
      </div>
    </div>
  )
}
