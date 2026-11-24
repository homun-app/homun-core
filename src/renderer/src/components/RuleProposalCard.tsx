// Card della regola di auto-review proposta dal bot (fase 8, §3bis L5): la
// regola si salva SOLO al click su "Aggiungi regola" (la RPC scrive nei
// settings); "Ignora" chiude la proposta senza salvare nulla.
//
// Fase design (DS4): ai token di DS1. Le due emoji dell'etichetta (⚡ per la
// regola che lascia continuare, ⛔ per quella che fa fermare) sono due icone
// lucide; i bottoni sono quelli del sistema.
import { useStore } from '../store'
import { Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { Ban, Zap } from 'lucide-react'
import { i18n } from '../lib/i18n'
import { DecidedRow, CardShell } from './DecidedRow'
import { Button } from './ui/button'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'

type Rule = Extract<SendMessagePayload, { type: 'rule' }>

/** L'etichetta della proposta: icona e parole dicono che cosa farà la regola. */
function RuleHead({ kind }: { kind: Rule['kind'] }) {
  return (
    <p className="flex items-center gap-2 text-caption font-medium text-chart-2">
      {kind === 'allow' ? <Zap className="size-4 shrink-0" aria-hidden="true" /> : <Ban className="size-4 shrink-0" aria-hidden="true" />}
      {kind === 'allow'
        ? <Trans>Regola proposta — continuo da solo quando…</Trans>
        : <Trans>Regola proposta — mi fermo e chiedo sempre quando…</Trans>}
    </p>
  )
}

/** Il testo della card: etichetta, la regola, il perché. */
function RuleBody({ rule }: { rule: Rule }) {
  return (
    <>
      <RuleHead kind={rule.kind} />
      <p className="mt-1.5 wrap-anywhere text-body text-foreground">{rule.text}</p>
      {rule.why && <p className="mt-1 text-small text-muted-foreground">{rule.why}</p>}
    </>
  )
}

export function RuleProposalCard({ entry }: { entry: TranscriptEntry }) {
  const decide = useStore((s) => s.autoreviewRuleDecision)
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const rule = meta.message as Rule | undefined
  if (!rule) return null
  const decided = meta.ruleStatus

  // fase 16b (S6): dopo la decisione, UNA riga riapribile in sola lettura
  if (decided) {
    return (
      <DecidedRow
        ok={decided === 'added'}
        label={decided === 'added' ? i18n.t(msg`Regola aggiunta`) : i18n.t(msg`Proposta ignorata`)}
        at={entry.createdAt}
      >
        <CardShell>
          <RuleBody rule={rule} />
        </CardShell>
      </DecidedRow>
    )
  }
  return (
    <CardShell>
      <RuleBody rule={rule} />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={() => decide(entry.id, 'add')}>
          <Trans>Aggiungi regola</Trans>
        </Button>
        <Button variant="ghost" onClick={() => decide(entry.id, 'dismiss')}>
          <Trans>Ignora</Trans>
        </Button>
      </div>
    </CardShell>
  )
}
