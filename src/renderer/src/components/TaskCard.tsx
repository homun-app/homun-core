// Card del task thread (fase 8, §3bis L7): l'unica riga del task nella chat
// principale — titolo, stato live, ultima attività, "Apri" (vista del
// sotto-transcript) e "Interrompi". Lo stato arriva dalla tabella tasks
// (aggiornata via eventi), non dal testo del modello.
import { useStore } from '../store'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { t, msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'
import type { TaskInfo } from '../../../shared/types'

const STATUS_LABEL: Record<TaskInfo['status'], MessageDescriptor> = {
  working: msg`in corso`,
  needs_input: msg` attende la tua risposta`,
  done: msg`completato`,
  failed: msg`non riuscito`,
  cancelled: msg`annullato`
}
const STATUS_CLS: Record<TaskInfo['status'], string> = {
  working: 'text-primary',
  needs_input: 'text-destructive',
  done: 'text-chart-2',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground'
}

function fmtAgo(at: number, now: number): MessageDescriptor {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return msg`${s} s fa`
  if (s < 3600) return msg`${Math.round(s / 60)} min fa`
  return msg`${Math.round(s / 3600)} h fa`
}

export function TaskCard({ entry }: { entry: TranscriptEntry }) {
  const { i18n } = useLingui()
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
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-primary/80"><Trans>Task</Trans></span>
        <span className={`text-[11px] font-medium ${STATUS_CLS[status]}`}>
          {status === 'working' ? '⏳' : status === 'needs_input' ? '❓' : status === 'done' ? '✓' : status === 'failed' ? '⚠' : '⛔'}
          {' '}{i18n.t(STATUS_LABEL[status])}
        </span>
      </div>
      <p className="mt-1 text-sm text-foreground">{message.title}</p>
      {task && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          <Trans>ultima attività {i18n.t(fmtAgo(task.updatedAt, now))}{status === 'needs_input' ? t` — rispondi dalla vista del task (Apri)` : ''}</Trans>
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          className="rounded-lg border border-primary bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          onClick={() => openTask(message.taskId)}
        >
          <Trans>Apri</Trans>
        </button>
        {open && (
          <button
            className="rounded-lg bg-muted px-3 py-1.5 text-xs text-foreground hover:bg-accent"
            onClick={() => cancelTask(message.taskId)}
          >
            <Trans>Interrompi</Trans>
          </button>
        )}
      </div>
    </div>
  )
}
