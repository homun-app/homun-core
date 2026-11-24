// Card del task thread (fase 8, §3bis L7): l'unica riga del task nella chat
// principale — titolo, stato live, ultima attività, "Apri" (vista del
// sotto-transcript) e "Interrompi". Lo stato arriva dalla tabella tasks
// (aggiornata via eventi), non dal testo del modello.
// Fase design (DS4): ai token di DS1 — le misure di testo, le distanze e i
// bottoni del sistema; la logica non cambia.
import { useStore } from '../store'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'
import type { TaskInfo } from '../../../shared/types'
import { CardShell } from './DecidedRow'
import { Button } from './ui/button'
// P6 (fase uso-permessi): lo stato col SEGNO della barra, niente emoji
import { StateSign } from './StateSign'

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

/** P6 (fase uso-permessi): lo stato della card come stato della BARRA (StateSign, mai emoji). */
const STATUS_SIGN: Record<TaskInfo['status'], 'lavora' | 'aspetta-te' | 'finito' | 'fermo'> = {
  working: 'lavora',
  needs_input: 'aspetta-te',
  done: 'finito',
  failed: 'fermo',
  cancelled: 'fermo'
}

function fmtAgo(at: number, now: number): MessageDescriptor {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return msg`${s} s fa`
  if (s < 3600) return msg`${Math.round(s / 60)} min fa`
  return msg`${Math.round(s / 3600)} h fa`
}

export function TaskCard({ entry }: { entry: TranscriptEntry }) {
  const { t, i18n } = useLingui()
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
    // DS4, l'anatomia di una card della chat: in cima l'etichetta (text-caption
    // grigia) con lo stato a destra; il titolo text-body in peso medio; la
    // seconda riga text-small grigia; le azioni a 16 px dal resto, e sono i
    // bottoni del sistema (la principale è una pillola, le altre testo)
    <CardShell>
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-muted-foreground"><Trans>Task</Trans></span>
        {/* P6: il segno della barra accanto alla parola — mai emoji di stato */}
        <span className={`flex items-center gap-1.5 text-caption font-medium ${STATUS_CLS[status]}`} data-testid="task-stato">
          <StateSign state={STATUS_SIGN[status]} testid="task-segno" />
          {i18n.t(STATUS_LABEL[status])}
        </span>
      </div>
      <p className="mt-1.5 text-body font-medium text-foreground">{message.title}</p>
      {task && (
        <p className="mt-0.5 text-small text-muted-foreground">
          <Trans>ultima attività {i18n.t(fmtAgo(task.updatedAt, now))}{status === 'needs_input' ? t` — rispondi dalla vista del task (Apri)` : ''}</Trans>
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={() => openTask(message.taskId)}>
          <Trans>Apri</Trans>
        </Button>
        {open && (
          <Button variant="ghost" onClick={() => cancelTask(message.taskId)}>
            <Trans>Interrompi</Trans>
          </Button>
        )}
      </div>
    </CardShell>
  )
}
