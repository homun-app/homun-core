// B3 (fase beta.4): «Routine creata (in pausa)» col bottone «Attiva». La
// routine NASCE in pausa (il clic dell'utente è il consenso) e il bot dice
// «devi attivarla dall'app»: ora basta un clic lì. Se manca il fuso orario,
// prima lo chiede con la STESSA UI della pagina Routine (input col
// placeholder «Fuso orario (es. Europe/Rome)»).
import { useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { api } from '../store'
import { uiTextOf } from '../lib/ui-text'
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
    <span className="mt-1 flex items-center gap-1.5">
      <input
        className="w-44 rounded-lg bg-muted px-2 py-1 text-xs outline-none placeholder:text-muted-foreground"
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
      <button
        type="button"
        data-testid="routine-tz-confirm"
        disabled={busy || !tz.trim()}
        className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs transition hover:bg-accent disabled:opacity-40"
        onClick={() => {
          setBusy(true)
          void api.updateRoutineTrigger(routineId, { enabled: 1, timezone: tz.trim() }).then(onDone, onDone)
        }}
      >
        <Trans>Conferma</Trans>
      </button>
    </span>
  )
}

/**
 * La riga «Routine creata (in pausa): …» col bottone «Attiva»: un clic e la
 * routine parte (il consenso è il clic, la routine resta in pausa senza).
 */
export function RoutineCreatedRow({ entry }: { entry: TranscriptEntry }) {
  const automation = (entry.meta as { automation?: { action?: unknown; id?: unknown } } | null)?.automation
  const routineId = Number(automation?.id)
  const [askTz, setAskTz] = useState(false)
  const [busy, setBusy] = useState(false)
  const [gone, setGone] = useState(false)
  if (automation?.action !== 'create' || !Number.isInteger(routineId) || routineId <= 0) {
    return <p className="text-center text-xs text-muted-foreground">{uiTextOf(entry)}</p>
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
    <p className="flex flex-wrap items-center justify-center gap-2 text-center text-xs text-muted-foreground">
      {uiTextOf(entry)}
      {gone ? (
        <Trans>attivata</Trans>
      ) : askTz ? (
        <RoutineTzAsk routineId={routineId} onDone={() => setGone(true)} />
      ) : (
        <button
          type="button"
          data-testid="routine-activate"
          disabled={busy}
          className="rounded-full bg-muted px-3 py-1 text-xs text-foreground transition hover:bg-accent disabled:opacity-40"
          onClick={() => activate()}
        >
          <Trans>Attiva</Trans>
        </button>
      )}
    </p>
  )
}
