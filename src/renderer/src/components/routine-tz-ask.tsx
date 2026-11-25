// La domanda del FUSO ORARIO quando si attiva una routine senza fuso: la
// STESSA UI della pagina Routine (Impostazioni), così l'utente vede un pezzo
// solo. C0 (fase linguaggio): file suo, estratto da RoutineCreatedRow.tsx —
// l'import della card lo rende usato dal prodotto (prima l'export serviva
// solo ai test: la card lo raggiunge dopo un clic e una risposta del daemon,
// non in un render statico).
import { useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { api } from '../store'
import { Button } from './ui/button'

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

