// Fase 16b (S6): la riga UNA che resta dopo la decisione — «Consentito una
// volta · <sintesi> · 10:44», col suo segno. Un clic la riapre in sola lettura
// (i bottoni non tornano). Vale per approvazioni, domande, bozze, presa di
// controllo e salvataggi nel vault.
//
// Fase design (DS4): la riga e le card passano ai token di DS1.
//  - la riga è una riga di sistema compatta (text-small grigia, alta 32) che
//    si apre: i suoi segni sono icone lucide da 16 — prima i glifi ✓ ✗ ▾ ▸
//    scritti nel testo;
//  - la card è una superficie (rounded-surface) con il respiro di 16, larga
//    al massimo l'85% della colonna; dentro, i blocchi (il comando, i
//    dettagli) hanno il raggio di controllo su fondo card: CardBlock;
//  - le righe di sistema che si aprono (le aperture automatiche, il
//    ragionamento, i passaggi di debug, la delega a un altro bot) sono
//    SystemRow + SystemText: la riga è Notice, il testo un blocco di codice.
import { useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Check, ChevronDown, ChevronRight, X, type LucideIcon } from 'lucide-react'
import { formatTime } from '../lib/i18n'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Notice } from './ui/notice'

/** Quanto è larga una card nella colonna della chat: al massimo l'85%, come le bolle. */
const LARGHEZZA_CARD = 'max-w-[85%]'

/**
 * Un bottone SECONDARIO dentro una card. La card è già `bg-muted`: con il suo
 * fondo di fabbrica il bottone secondary ci sparirebbe dentro. Sulla pagina è
 * un passo più scuro del fondo; sulla card resta un passo più chiaro (fondo
 * card), com'è sempre stato. Si aggiunge a `<Button variant="secondary">`.
 */
export const SU_CARD = 'bg-card hover:bg-card/80'

/**
 * Una riga di sistema che si apre (DS4): le righe di sistema sono Notice
 * (components/ui/notice) — icona lucide da 16 · testo grigio text-small · il
 * segno che si apre a destra — e il testo per il modello sta in un <details>
 * chiuso sotto. <summary> è la riga: un clic ovunque su di lei apre. Essendo
 * flex non ha più il triangolo del browser (il segno lo mette Notice, a
 * destra); l'anello del fuoco è quello delle righe di tabella — verso
 * l'interno, solo da tastiera — perché la riga è larga quanto la colonna e
 * scorre sotto la testata.
 * Vive qui, e non in Chat.tsx, perché la usano anche le righe che stanno in
 * un file loro (AgentSendRow): da Chat verrebbe un import circolare.
 */
export function SystemRow({ icon: Icon, children, tone = 'neutral', testId }: {
  icon: LucideIcon
  children: React.ReactNode
  tone?: 'neutral' | 'warning' | 'destructive'
  testId?: string
}) {
  return (
    <summary
      className="flex cursor-pointer items-center outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
      data-testid={testId}
    >
      <Notice icon={<Icon className="size-4" />} tone={tone} action={<ChevronDown className="size-4" aria-hidden="true" />}>
        {children}
      </Notice>
    </summary>
  )
}

/**
 * Il testo per il modello dentro una riga di sistema (DS4): un blocco di
 * codice come gli altri del markdown — raggio di controllo, text-small
 * monospazio — che scorre dentro se stesso. `className` porta quanto è alto
 * al più (si legge scorrendo dentro).
 */
export function SystemText({ text, className = 'max-h-40' }: { text: string; className?: string }) {
  return (
    <pre className={cn('mt-1 scroll-thin overflow-auto whitespace-pre-wrap wrap-anywhere rounded-control bg-muted p-3 font-mono text-small text-muted-foreground', className)}>
      {text}
    </pre>
  )
}

export function DecidedRow({
  ok,
  label,
  summary,
  at,
  children
}: {
  /** true = segno di spunta (consentito/inviato/salvato), false = segno di croce (rifiutato/scartato) */
  ok: boolean
  /** l'esito in parole: «Consentito una volta», «Inviata a x@y.it»… */
  label: string
  /** la sintesi dell'azione (comando, destinatario, scelta…) */
  summary?: string
  at?: number
  /** la card in sola lettura, mostrata quando la riga è aperta */
  children?: React.ReactNode
}) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  return (
    <div>
      {/* il bottone del sistema (ghost, 32) con il testo di una riga di sistema:
          text-small grigia, in peso normale — si legge come una riga, non come
          un'etichetta. Sulla riga intera, allineato a sinistra */}
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start font-normal text-small"
        onClick={() => children && setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={ok ? 'text-chart-2' : 'text-muted-foreground'}>
          {ok ? <Check className="size-4" /> : <X className="size-4" />}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {label}
          {summary ? ` · ${summary}` : ''}
        </span>
        {at !== undefined && <span className="shrink-0 text-caption">{formatTime(at)}</span>}
        {children && (
          <span aria-hidden="true" className="shrink-0">
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </span>
        )}
      </Button>
      {open && <div className="mt-2">{children}</div>}
      {!open && <span className="sr-only">{t`riapri in sola lettura`}</span>}
    </div>
  )
}

/** Il contenitore di tutte le card: una superficie (raggio di superficie, respiro 16), al massimo l'85% della colonna (S6, DS4). */
export function CardShell({
  tone = 'muted',
  className,
  testid,
  children
}: {
  tone?: 'muted' | 'waiting' | 'error' | 'bot'
  className?: string
  /** K1 (ritocchi): ancora stabile per la sonda (la card dev'essere VISIBILE in cima) */
  testid?: string
  children: React.ReactNode
}) {
  const toneCls =
    tone === 'waiting'
      ? 'bg-waiting/10'
      : tone === 'error'
        ? 'bg-destructive/10'
        : 'bg-muted'
  return (
    // RW4: min-w-0 + overflow-wrap — il contenuto lungo (endpoint, comandi)
    // va a capo DENTRO la card, mai una card che allarga la chat
    <div className={cn(LARGHEZZA_CARD, 'min-w-0 rounded-surface p-4 wrap-anywhere', toneCls, className)} {...(testid ? { 'data-testid': testid } : {})}>
      {children}
    </div>
  )
}

/**
 * Un blocco DENTRO una card (DS4): il comando da approvare, i dettagli, il
 * corpo di una bozza — su fondo card, col raggio di controllo (8: dentro una
 * superficie da 14) e il respiro di 12. Le card della chat lo usano al posto
 * di riquadri scritti ognuno a mano.
 */
export function CardBlock({ className, testid, children }: {
  className?: string
  testid?: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <div className={cn('rounded-control bg-card p-3', className)} {...(testid ? { 'data-testid': testid } : {})}>
      {children}
    </div>
  )
}
