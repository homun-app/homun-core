// Fase impostazioni (I5): «Avanzate» chiuso, con la freccia — il posto delle
// cose da sviluppatore (parametri del daemon, regole per strumento). Il
// contenuto si monta SOLO aperto (niente stato nascosto che gira).
//
// Fase design (DS4, Impostazioni): l'icona è una delle due misure di DS1 (16
// px: prima 14) e la misura è scritta FISSA nell'attributo dell'icona — la
// guardia la legge lì (e da main anche dentro un template literal, dai suoi
// pezzi fissi: una espressione no). Per questo a girare è l'involucro, non
// l'icona. Il bottone è alto 32 come ogni controllo (h-control-sm): prima era
// alto quanto la riga di testo (18 px), un bersaglio troppo piccolo; il suo
// respiro (px-2) esce a sinistra (-ml-2), così la parola resta sotto la
// colonna. Niente più il 4 px in cima (pt-1): la distanza è quella fra i
// blocchi della pagina (SettingsPage); il contenuto aperto sta a 12 px
// (gap-section-head) e i suoi gruppi a 16 (gap-block).
import { useState, type ReactNode } from 'react'
import { Trans } from '@lingui/react/macro'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import { FOCUS_RING } from './SettingsRow'

export function SettingsAdvanced({ children, label, defaultOpen = false }: { children: ReactNode; label?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="flex flex-col gap-section-head">
      <button
        type="button"
        aria-expanded={open}
        className={cn('-ml-2 flex h-control-sm shrink-0 items-center gap-1 self-start rounded-control px-2 text-small text-muted-foreground transition hover:text-foreground', FOCUS_RING)}
        onClick={() => setOpen((v) => !v)}
      >
        {label ?? <Trans>Avanzate</Trans>}
        <span className={cn('flex shrink-0 transition-transform', open && 'rotate-180')}>
          <ChevronDown className="size-4" />
        </span>
      </button>
      {open && <div className="flex flex-col gap-block">{children}</div>}
    </div>
  )
}
