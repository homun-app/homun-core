// B3 (fase beta.4): «Routine creata (in pausa)» col bottone «Attiva». La
// routine NASCE in pausa (il clic dell'utente è il consenso) e il bot dice
// «devi attivarla dall'app»: ora basta un clic lì. Se manca il fuso orario,
// prima lo chiede con la STESSA UI della pagina Routine (input col
// placeholder «Fuso orario (es. Europe/Rome)»).
import { useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Check } from 'lucide-react'
import { api } from '../store'
import { uiTextOf } from '../lib/ui-text'
import { Button } from './ui/button'
import { Notice } from './ui/notice'
import type { TranscriptEntry } from '../../../shared/types'

/**
 * Il piano del clic su «Attiva» (PURO): col fuso orario si attiva subito;
 * senza (o routine sparita) prima si chiede il fuso all'utente.
 */
export function activatePlanOf(routine: { timezone?: string } | null | undefined): 'activate' | 'ask-timezone' {
  return routine && routine.timezone ? 'activate' : 'ask-timezone'
}

/** La domanda del fuso orario: la stessa UI della pagina Routine. */
export function RoutineTzAsk({ routineId, onDone }: { routineId: number; onDone(): void }) {
  const { t } = useLingui()
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [busy, setBusy] = useState(false)
  return (
    // DS4: campo e bottone dei token (36 px, raggio di controllo; azione in un bottone da 32)
    <span className="flex flex-wrap items-center gap-2">
      <input
        className="h-control w-44 rounded-control bg-card px-3 text-body outline-none placeholder:text-muted-foreground"
        placeholder={t`Fuso orario (es. Europe/Rome)`}
        aria-label={t`Fuso orario (es. Europe/Rome)`}
        value={tz}
        disabled={busy}
        onChange={(e) => setTz(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && tz.trim() && !busy) {
            setBusy(true)
            void api.updateRoutineTrigger(routineId, { enabled: 1, timezone: tz.trim() }).then(onDone, onDone)
          }
        }}
      />
      <Button
        variant="secondary"
        size="sm"
        data-testid="routine-tz-confirm"
        disabled={busy || !tz.trim()}
        onClick={() => {
          setBusy(true)
          void api.updateRoutineTrigger(routineId, { enabled: 1, timezone: tz.trim() }).then(onDone, onDone)
        }}
      >
        <Trans>Conferma</Trans>
      </Button>
    </span>
  )
}

/**
 * La riga «Routine creata (in pausa): …» col bottone «Attiva»: un clic e la
 * routine parte (il consenso è il clic, la routine resta in pausa senza).
 * Fase design (DS4): è una riga di sistema (Notice); l'azione — «Attiva», la
 * domanda del fuso, l'esito — sta al suo posto, a destra.
 */
export function RoutineCreatedRow({ entry }: { entry: TranscriptEntry }) {
  const automation = (entry.meta as { automation?: { action?: unknown; id?: unknown } } | null)?.automation
  const routineId = Number(automation?.id)
  const [askTz, setAskTz] = useState(false)
  const [busy, setBusy] = useState(false)
  const [gone, setGone] = useState(false)
  if (automation?.action !== 'create' || !Number.isInteger(routineId) || routineId <= 0) {
    return <Notice>{uiTextOf(entry)}</Notice>
  }
  const activate = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      // la routine può essere cambiata (o sparita) da quando è nata: il fuso
      // si legge adesso, dalla riga vera
      const routines = await api.listRoutines(entry.agentId).catch(() => [])
      const routine = routines.find((r) => r.id === routineId) as { id: number; timezone?: string } | undefined
      if (activatePlanOf(routine ?? null) === 'activate') {
        await api.updateRoutine(routineId, { enabled: 1 })
        setGone(true)
      } else {
        setAskTz(true) // senza fuso: prima lo chiede (la routine resta in pausa)
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <Notice
      action={
        gone ? (
          // attivata: il segno di spunta in verde, come gli esiti felici dell'interfaccia
          <span className="flex items-center gap-1 text-chart-2">
            <Check className="size-4" aria-hidden="true" />
            <Trans>attivata</Trans>
          </span>
        ) : askTz ? (
          <RoutineTzAsk routineId={routineId} onDone={() => setGone(true)} />
        ) : (
          <Button variant="ghost" size="sm" data-testid="routine-activate" disabled={busy} onClick={() => activate()}>
            <Trans>Attiva</Trans>
          </Button>
        )
      }
    >
      {uiTextOf(entry)}
    </Notice>
  )
}
