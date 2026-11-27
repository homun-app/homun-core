// K3 (fase conversione-chat): Disclosure — LA RIGA DI SISTEMA CHE SI APRE.
// Nella chat restano righe che non sono messaggi: l'esito di una decisione
// («Consentito una volta · rm -rf … · 10:44»), l'apertura automatica, il
// ragionamento, un passaggio di debug. Sono COMPATTE (text-small, il peso
// normale di una riga), occupano la colonna e con un clic si APRONO su ciò
// che c'è sotto, in sola lettura. Prima ognuna si scriveva a mano in
// DecidedRow.tsx e in Chat.tsx, con le sue classi. Due modi di aprirsi, una
// sola riga:
//   · Disclosure          il bottone che apre un contenuto gestito da chi la
//                         usa (DecidedRow: lo stato è suo);
//   · DisclosureSummary   la riga <summary> di un <details> nativo (il testo
//                         per il modello: Chat.tsx, AgentSendRow).
// È solo la vista: che cosa mostrarci lo decide chi la usa.
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from './button'
import { Notice } from './notice'

/** Il colore del segno: normale (il grigio del bottone) · riuscito (il verde dei grafici) · grigio. */
const TONO = { normal: '', ok: 'text-chart-2', muted: 'text-muted-foreground' } as const

/**
 * La riga che apre: il segno · il testo (si tronca) · il metadato a destra
 * (l'ora) · la freccia quando c'è qualcosa da aprire. `aperto` va in
 * aria-expanded; `apribile` mostra la freccia (giù quando è aperta).
 */
export function Disclosure({ segno, testo, metadato, aperto, apribile = false, tone = 'normal', onClick, testId, className }: {
  /** il segno davanti al testo: un'icona lucide da 16 */
  segno?: ReactNode
  /** il testo della riga: si tronca su una riga sola */
  testo: ReactNode
  /** il dato a destra, ai didascalie (l'ora) */
  metadato?: ReactNode
  /** aperta o chiusa (aria-expanded); undefined quando la riga non apre nulla */
  aperto?: boolean
  /** c'è qualcosa da aprire: la freccia a destra */
  apribile?: boolean
  /** il colore del segno */
  tone?: 'normal' | 'ok' | 'muted'
  onClick?(): void
  testId?: string
  className?: string
}): ReactNode {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn('w-full justify-start font-normal text-small', className)}
      onClick={onClick}
      aria-expanded={aperto}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {segno !== undefined && <span className={TONO[tone]}>{segno}</span>}
      <span className="min-w-0 flex-1 truncate">{testo}</span>
      {metadato !== undefined && <span className="shrink-0 text-caption">{metadato}</span>}
      {apribile && (
        <span aria-hidden="true" className="shrink-0">
          {aperto ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
      )}
    </Button>
  )
}

/**
 * La riga <summary> di un <details> nativo: la riga di sistema (Notice —
 * icona · testo grigio · la freccia) che apre ciò che sta sotto, nel
 * <details> di chi la usa (per esempio Code). Un clic ovunque sulla riga
 * apre; il triangolo del browser non si vede.
 */
export function DisclosureSummary({ icon: Icon, children, tone = 'neutral', testId }: {
  icon: LucideIcon
  children: ReactNode
  tone?: 'neutral' | 'warning' | 'destructive'
  testId?: string
}): ReactNode {
  return (
    <summary
      className="flex cursor-pointer items-center select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <Notice icon={<Icon className="size-4" />} tone={tone} action={<ChevronDown className="size-4" aria-hidden="true" />}>
        {children}
      </Notice>
    </summary>
  )
}
