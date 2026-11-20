// Card del sottoagente (fase 12, punto 7): l'unica riga del figlio nella chat
// del padre — titolo, stato live (dalla tabella subagents + stato dell'agente
// figlio: paused-for-approval = "in attesa di conferma"), tempo trascorso e i
// bottoni Apri (pannello del transcript del figlio) e Ferma. Come TaskCard, lo
// stato arriva dal registro, non dal testo del modello.
// AH2 (fase aiutanti): quando il figlio ha un'approvazione IN ATTESA, la card
// del FIGLIO compare QUI SOTTO — è la STESSA approvazione (entry del figlio,
// letta da subagents:list), il clic risolve sul figlio (entry.agentId, AH1).
// AH3 (fase aiutanti): la card è VIVA — lo stato cambia senza ricaricare la
// chat (il daemon emette subagents al cambio di stato del figlio), la riga
// dell'attività corrente riusa le etichette della riga del bot (mai l'argomento
// grezzo), il tempo scorre ogni secondo finché il figlio è aperto e i passi si
// contano.
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload, SubagentInfo } from '../../../shared/types'
import { CardShell } from './DecidedRow'
import { ApprovalCard } from './ApprovalCard'
import { activityPhrase } from '../lib/activity'

const STATUS_LABEL: Record<SubagentInfo['status'], MessageDescriptor> = {
  queued: msg`in coda`,
  running: msg`al lavoro`,
  done: msg`finito`,
  failed: msg`fallito`,
  stopped: msg`fermato`,
  // fase chat-limiti (CL5): fermato dal controllo anti-loop — l'esito si VEDE
  'stopped-loop': msg`interrotto`,
  expired: msg`scaduto`
}
const STATUS_CLS: Record<SubagentInfo['status'], string> = {
  queued: 'text-muted-foreground',
  running: 'text-primary',
  done: 'text-chart-2',
  failed: 'text-destructive',
  stopped: 'text-muted-foreground',
  'stopped-loop': 'text-destructive',
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
  // P4 (fase uso-permessi): «Decidi» apre il centro «Da approvare» SU quella
  // richiesta — l'utente decide senza aprire l'aiutante
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const message = meta.message as Extract<SendMessagePayload, { type: 'subagent' }> | undefined
  // AH3: l'attività corrente del figlio (gli eventi activity arrivano per il
  // SUO id) — stessa etichetta della riga del bot. Hook PRIMA dell'early return
  const activity = useStore((s) => (message ? s.activity[message.subagentId] : undefined))
  // AH3: il tempo scorre — un tick al secondo finché la card è di un figlio aperto
  const sub = message ? subagents.find((x) => x.id === message.subagentId) : undefined
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!(sub === undefined || sub.status === 'queued' || sub.status === 'running')) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [sub?.status])
  if (!message) return null
  const open = sub === undefined || sub.status === 'queued' || sub.status === 'running'
  // stato live: il registro dice queued/running/…; un figlio fermo su una card
  // dell'utente è "in attesa di conferma" — AH3: colore e icona propri
  const waiting = sub?.status === 'running' && sub.agentStatus === 'paused-for-approval'
  const status = sub?.status ?? 'queued'

  return (
    <>
      <CardShell testid="card-aiutante">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground"><Trans>Aiutante</Trans></span>
          <span
            className={`text-[11px] font-medium ${waiting ? 'text-waiting' : STATUS_CLS[status]}`}
            data-testid="card-aiutante-stato"
          >
            {waiting
              ? `✋ ${t`in attesa della tua conferma`}`
              : `${status === 'done' ? '✓' : status === 'failed' ? '⚠' : status === 'stopped' ? '⛔' : status === 'stopped-loop' ? '⏹' : status === 'expired' ? '⏱' : '⏳'} ${i18n.t(STATUS_LABEL[status])}`}
          </span>
        </div>
        <p
          className="mt-1 cursor-pointer text-sm text-foreground transition hover:underline"
          onClick={() => openSubagent(message.subagentId)}
        >
          {message.title}
        </p>
        {sub && (
          <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="aiutante-tempo">
            <Trans>{i18n.t(fmtAgo(sub.startedAt ?? sub.createdAt, now))} trascorsi · {sub.steps} {sub.steps === 1 ? t`passo` : t`passi`}{sub.status === 'done' && sub.summary ? ` — ${sub.summary.slice(0, 120)}` : ''}</Trans>
          </p>
        )}
        {sub && open && activity && (
          <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="aiutante-attivita">
            {i18n.t(activityPhrase(activity, 'present', i18n.locale === 'en' ? 'en' : 'it'))}
          </p>
        )}
        {/* P4 (fase uso-permessi): l'aiutante che aspetta una decisione si VEDE
            qui, nella chat del padre — «aspetta te» (lo stato della barra) con
            la FRASE della richiesta e «Decidi» che apre il centro su di essa */}
        {waiting && (sub?.pendingApprovals?.length ?? 0) > 0 && (
          <div className="mt-2 flex items-start justify-between gap-2 rounded-[12px] bg-waiting/10 px-3 py-2" data-testid="card-aiutante-aspetta-te">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-waiting"><Trans>aspetta te</Trans></p>
              <p className="mt-0.5 line-clamp-2 text-xs text-foreground/80">
                {sub!.pendingApprovals![0]!.content}
              </p>
            </div>
            <button
              className="shrink-0 self-center rounded-[10px] bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition hover:opacity-90"
              data-testid="aiutante-decidi"
              onClick={() => setApprovalsOpen(true, String(sub!.pendingApprovals![0]!.meta?.approvalId ?? ''))}
            >
              <Trans>Decidi</Trans>
            </button>
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <button
            className="rounded-[10px] bg-card px-3.5 py-1.5 text-sm transition hover:bg-muted"
            onClick={() => openSubagent(message.subagentId)}
          >
            <Trans>Apri</Trans>
          </button>
          {open && sub && (
            <button
              className="rounded-[10px] px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
              onClick={() => stopSubagent(message.subagentId)}
            >
              <Trans>Ferma</Trans>
            </button>
          )}
        </div>
      </CardShell>
      {/* AH2: le approvazioni del figlio, la STESSA card del suo transcript —
          decisa qui si risolve sul FIGLIO (entry.agentId) e, decisa altrove,
          sparisce da qui (il daemon emette subagents alla risoluzione) */}
      {(sub?.pendingApprovals ?? []).map((ap) => (
        <div key={ap.id} data-testid="aiutante-card-figlio" className="mt-1">
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">
            <Trans>L’aiutante «{message.title}» chiede:</Trans>
          </p>
          <ApprovalCard entry={ap} ownerName={message.title} />
        </div>
      ))}
    </>
  )
}
