// Fase impostazioni (I5): «Avanzate» chiuso, con la freccia — il posto delle
// cose da sviluppatore (parametri del daemon, regole per strumento). Il
// contenuto si monta SOLO aperto (niente stato nascosto che gira).
import { useState, type ReactNode } from 'react'
import { Trans } from '@lingui/react/macro'
import { ChevronDown } from 'lucide-react'

export function SettingsAdvanced({ children, label, defaultOpen = false }: { children: ReactNode; label?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="pt-1">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1 text-[13px] text-muted-foreground transition hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {label ?? <Trans>Avanzate</Trans>}
        <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-3 space-y-4">{children}</div>}
    </div>
  )
}
