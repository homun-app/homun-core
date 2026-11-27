// Card della regola di auto-review proposta dal bot (fase 8, §3bis L5): la
// regola si salva SOLO al click su "Aggiungi regola" (la RPC scrive nei
// settings); "Ignora" chiude la proposta senza salvare nulla.
//
// Fase design (DS4): ai token di DS1. Le due emoji dell'etichetta (⚡ per la
// regola che lascia continuare, ⛔ per quella che fa fermare) sono due icone
// lucide; i bottoni sono quelli del sistema.
//
// K3 (fase conversione-chat): la card è LOGICA sopra il guscio (ChatCard):
// il segno della proposta (Zap · Ban) nella testata, l'etichetta come
// titolo, la regola in corpo, il perché grigio, le azioni in fondo. Dopo la
// decisione la riga è Disclosure (DecidedRow) e la card si riapre in sola
// lettura dentro il suo stesso guscio.
import { useStore } from '../store'
import { Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { Ban, Zap } from 'lucide-react'
import { i18n } from '../lib/i18n'
import { DecidedRow } from './DecidedRow'
import { Button } from './ui/button'
import { ChatCard } from './ui/chat-card'
import { Text } from './ui/text'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'

type Rule = Extract<SendMessagePayload, { type: 'rule' }>

/** L'etichetta della proposta: le parole dicono che cosa farà la regola; il segno (Zap · Ban) sta accanto, nella testata. */
function ruleTitolo(kind: Rule['kind']): React.ReactNode {
  return kind === 'allow'
    ? <Trans>Regola proposta — continuo da solo quando…</Trans>
    : <Trans>Regola proposta — mi fermo e chiedo sempre quando…</Trans>
}

export function RuleProposalCard({ entry }: { entry: TranscriptEntry }) {
  const decide = useStore((s) => s.autoreviewRuleDecision)
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const rule = meta.message as Rule | undefined
  if (!rule) return null
  const decided = meta.ruleStatus

  // K3: testata e corpo sono gli stessi, decisa o no
  const testa = { icona: rule.kind === 'allow' ? Zap : Ban, titolo: ruleTitolo(rule.kind) } as const
  const corpo = (
    <>
      <Text>{rule.text}</Text>
      {rule.why && <Text size="small" tone="muted">{rule.why}</Text>}
    </>
  )

  // fase 16b (S6): dopo la decisione, UNA riga riapribile in sola lettura
  if (decided) {
    return (
      <DecidedRow
        ok={decided === 'added'}
        label={decided === 'added' ? i18n.t(msg`Regola aggiunta`) : i18n.t(msg`Proposta ignorata`)}
        at={entry.createdAt}
      >
        <ChatCard {...testa}>
          {corpo}
        </ChatCard>
      </DecidedRow>
    )
  }
  return (
    <ChatCard
      {...testa}
      azioni={
        <>
          <Button onClick={() => decide(entry.id, 'add')}>
            <Trans>Aggiungi regola</Trans>
          </Button>
          <Button variant="ghost" onClick={() => decide(entry.id, 'dismiss')}>
            <Trans>Ignora</Trans>
          </Button>
        </>
      }
    >
      {corpo}
    </ChatCard>
  )
}
