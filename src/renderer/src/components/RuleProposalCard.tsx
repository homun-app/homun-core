// Card della regola di auto-review proposta dal bot (fase 8, §3bis L5): la
// regola si salva SOLO al click su "Aggiungi regola" (la RPC scrive nei
// settings); "Ignora" chiude la proposta senza salvare nulla.
import { useStore } from '../store'
import { Trans } from '@lingui/react/macro'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'

type Rule = Extract<SendMessagePayload, { type: 'rule' }>

export function RuleProposalCard({ entry }: { entry: TranscriptEntry }) {
  const decide = useStore((s) => s.autoreviewRuleDecision)
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const rule = meta.message as Rule | undefined
  if (!rule) return null
  const decided = meta.ruleStatus

  return (
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
      <p className="text-xs font-medium text-chart-2/90">
        {rule.kind === 'allow' ? <Trans>⚡ Regola proposta — continuo da solo quando…</Trans> : <Trans>⛔ Regola proposta — mi fermo e chiedo sempre quando…</Trans>}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{rule.text}</p>
      {rule.why && <p className="mt-1 text-xs text-muted-foreground">{rule.why}</p>}
      {decided ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {decided === 'added' ? <Trans>✓ Regola aggiunta (revocabile da Impostazioni → Approvazione automatica)</Trans> : <Trans>Proposta ignorata</Trans>}
        </p>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
            onClick={() => decide(entry.id, 'add')}
          >
            <Trans>Aggiungi regola</Trans>
          </button>
          <button
            className="rounded-lg bg-muted px-3 py-1.5 text-xs text-foreground hover:bg-accent"
            onClick={() => decide(entry.id, 'dismiss')}
          >
            <Trans>Ignora</Trans>
          </button>
        </div>
      )}
    </div>
  )
}
