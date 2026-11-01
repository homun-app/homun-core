// Card del sottoagente (fase 12, punto 7): l'unica riga del figlio nella chat
// del padre — titolo, stato live (dalla tabella subagents + stato dell'agente
// figlio: paused-for-approval = "in attesa di conferma"), tempo trascorso e i
// bottoni Apri (pannello del transcript del figlio) e Ferma. Come TaskCard, lo
// stato arriva dal registro, non dal testo del modello.
import { useStore } from '../store'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload, SubagentInfo } from '../../../shared/types'
import { CardShell } from './DecidedRow'

const STATUS_LABEL: Record<SubagentInfo['status'], MessageDescriptor> = {
  queued: msg`in coda`,
  running: msg`al lavoro`,
  done: msg`finito`,
  failed: msg`fallito`,
  stopped: msg`fermato`,
  expired: msg`scaduto`
}
const STATUS_CLS: Record<SubagentInfo['status'], string> = {
  queued: 'text-muted-foreground',
  running: 'text-primary',
  done: 'text-chart-2',
  failed: 'text-destructive',
  stopped: 'text-muted-foreground',
  expired: 'text-destructive'
}

function fmtAgo(at: number, now: number): MessageDescriptor {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return msg`${s} s`
  if (s < 3600) return msg`${Math.round(s / 60)} min`
  return msg`${Math.round(s / 3600)} h`
}

export function SubagentCard({ entry }: { entry: TranscriptEntry }) {
  const { t, i18n } = useLingui()
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
    <CardShell>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground"><Trans>Aiutante</Trans></span>
        <span className={`text-[11px] font-medium ${STATUS_CLS[status]}`}>
          {status === 'done' ? '✓' : status === 'failed' ? '⚠' : status === 'stopped' ? '⛔' : status === 'expired' ? '⏱' : '⏳'}
          {' '}{waiting ? t`in attesa di conferma` : i18n.t(STATUS_LABEL[status])}
        </span>
      </div>
      <p className="mt-1 text-sm text-foreground">{message.title}</p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          <Trans>{i18n.t(fmtAgo(sub.startedAt ?? sub.createdAt, now))} trascorsi{sub.status === 'done' && sub.summary ? ` — ${sub.summary.slice(0, 120)}` : ''}</Trans>
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          className="rounded-[10px] bg-card px-3.5 py-1.5 text-sm transition hover:bg-muted"
          onClick={() => openSubagent(message.subagentId)}
        >
          <Trans>Apri</Trans>
        </button>
        {open && (
          <button
            className="rounded-[10px] px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
            onClick={() => stopSubagent(message.subagentId)}
          >
            <Trans>Ferma</Trans>
          </button>
        )}
      </div>
    </CardShell>
  )
}
