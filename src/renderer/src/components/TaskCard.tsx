// Card del task thread (fase 8, §3bis L7): l'unica riga del task nella chat
// principale — titolo, stato live, ultima attività, "Apri" (vista del
// sotto-transcript) e "Interrompi". Lo stato arriva dalla tabella tasks
// (aggiornata via eventi), non dal testo del modello.
import { useStore } from '../store'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'
import type { TaskInfo } from '../../../shared/types'

const STATUS_LABEL: Record<TaskInfo['status'], string> = {
  working: 'in corso',
  needs_input: ' attende la tua risposta',
  done: 'completato',
  failed: 'non riuscito',
  cancelled: 'annullato'
}
const STATUS_CLS: Record<TaskInfo['status'], string> = {
  working: 'text-sky-300',
  needs_input: 'text-amber-300',
  done: 'text-emerald-400',
  failed: 'text-red-400',
  cancelled: 'text-neutral-500'
}

function fmtAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s} s fa`
  if (s < 3600) return `${Math.round(s / 60)} min fa`
  return `${Math.round(s / 3600)} h fa`
}

export function TaskCard({ entry }: { entry: TranscriptEntry }) {
  const tasks = useStore((s) => s.tasks)
  const openTask = useStore((s) => s.openTask)
  const cancelTask = useStore((s) => s.cancelTask)
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const message = meta.message as Extract<SendMessagePayload, { type: 'task' }> | undefined
  if (!message) return null
  // stato live dalla tabella tasks (fallback per task rimossi)
  const task = tasks.find((t) => t.id === message.taskId)
  const status = task?.status ?? 'working'
  const open = status === 'working' || status === 'needs_input'
  const now = Date.now()

  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-sky-800/40 bg-sky-950/10 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-sky-300/80">Task</span>
        <span className={`text-[11px] font-medium ${STATUS_CLS[status]}`}>
          {status === 'working' ? '⏳' : status === 'needs_input' ? '❓' : status === 'done' ? '✓' : status === 'failed' ? '⚠' : '⛔'}
          {' '}{STATUS_LABEL[status]}
        </span>
      </div>
      <p className="mt-1 text-sm text-neutral-100">{message.title}</p>
      {task && (
        <p className="mt-0.5 text-[11px] text-neutral-500">
          ultima attività {fmtAgo(task.updatedAt, now)}
          {status === 'needs_input' ? ' — rispondi dalla vista del task (Apri)' : ''}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          className="rounded-lg border border-sky-500 bg-sky-700/70 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600"
          onClick={() => openTask(message.taskId)}
        >
          Apri
        </button>
        {open && (
          <button
            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700"
            onClick={() => cancelTask(message.taskId)}
          >
            Interrompi
          </button>
        )}
      </div>
    </div>
  )
}
