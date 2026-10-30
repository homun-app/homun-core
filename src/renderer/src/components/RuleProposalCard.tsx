// Card della regola di auto-review proposta dal bot (fase 8, §3bis L5): la
// regola si salva SOLO al click su "Aggiungi regola" (la RPC scrive nei
// settings); "Ignora" chiude la proposta senza salvare nulla.
import { useStore } from '../store'
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
        {rule.kind === 'allow' ? '⚡ Regola proposta — continuo da solo quando…' : '⛔ Regola proposta — mi fermo e chiedo sempre quando…'}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{rule.text}</p>
      {rule.why && <p className="mt-1 text-xs text-muted-foreground">{rule.why}</p>}
      {decided ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {decided === 'added' ? '✓ Regola aggiunta (revocabile da Impostazioni → Approvazione automatica)' : 'Proposta ignorata'}
        </p>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
            onClick={() => decide(entry.id, 'add')}
          >
            Aggiungi regola
          </button>
          <button
            className="rounded-lg bg-muted px-3 py-1.5 text-xs text-foreground hover:bg-accent"
            onClick={() => decide(entry.id, 'dismiss')}
          >
            Ignora
          </button>
        </div>
      )}
    </div>
  )
}
