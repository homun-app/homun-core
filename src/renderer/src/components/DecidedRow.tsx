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
//
// K3 (fase conversione-chat): il file non disegna più. La riga che si apre è
// Disclosure (ui/disclosure.tsx), il testo per il modello è Code (ui/code.tsx).
// CardShell, CardBlock e SU_CARD restano qui come NOMI DI PRIMA per le card
// non ancora convertite (K4: bozze, domande, aiutanti, presa di controllo…;
// K5: la chat) e sono già pezzi del catalogo: la superficie di ChatCard
// senza il suo ritmo (ChatSurface), l'incavo dentro la card (CardBlock). Le
// card convertite usano ChatCard e i pezzi di components/ui/ direttamente;
// questi nomi spariscono con l'ultima.
import { useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Check, X } from 'lucide-react'
import { formatTime } from '../lib/i18n'
import { cn } from '../lib/utils'
import { Disclosure, DisclosureSummary } from './ui/disclosure'
import { ChatSurface, CardBlock as Block } from './ui/chat-card'
import { Code } from './ui/code'

export { SU_CARD } from './ui/button'

/**
 * Una riga di sistema che si apre (DS4): le righe di sistema sono Notice
 * (components/ui/notice) — icona lucide da 16 · testo grigio text-small · il
 * segno che si apre a destra — e il testo per il modello sta in un <details>
 * chiuso sotto. <summary> è la riga: un clic ovunque su di lei apre.
 * Vive qui, e non in Chat.tsx, perché la usano anche le righe che stanno in
 * un file loro (AgentSendRow): da Chat verrebbe un import circolare.
 */
export function SystemRow({ icon, children, tone = 'neutral', testId }: {
  icon: Parameters<typeof DisclosureSummary>[0]['icon']
  children: React.ReactNode
  tone?: 'neutral' | 'warning' | 'destructive'
  testId?: string
}) {
  return (
    <DisclosureSummary icon={icon} tone={tone} testId={testId}>
      {children}
    </DisclosureSummary>
  )
}

/**
 * Il testo per il modello dentro una riga di sistema (DS4): un blocco di
 * codice come gli altri del markdown, che scorre dentro se stesso.
 * `className` porta quanto è alto al più (si legge scorrendo dentro).
 */
export function SystemText({ text, className = 'max-h-40' }: { text: string; className?: string }) {
  return <Code aCapo className={cn('mt-1', className)}>{text}</Code>
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
      <Disclosure
        tone={ok ? 'ok' : 'muted'}
        segno={ok ? <Check className="size-4" /> : <X className="size-4" />}
        testo={<>{label}{summary ? ` · ${summary}` : ''}</>}
        metadato={at !== undefined ? formatTime(at) : undefined}
        aperto={open}
        apribile={children !== undefined}
        onClick={() => children && setOpen((v) => !v)}
      />
      {open && <div className="mt-2">{children}</div>}
      {!open && <span className="sr-only">{t`riapri in sola lettura`}</span>}
    </div>
  )
}

/** K3: la superficie di ChatCard senza il suo ritmo (ChatSurface) — per le card non ancora convertite (K4, K5). */
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
  return (
    // RW4: min-w-0 + overflow-wrap — il contenuto lungo (endpoint, comandi)
    // va a capo DENTRO la card, mai una card che allarga la chat
    <ChatSurface tone={tone === 'bot' ? 'muted' : tone} className={className} testId={testid}>
      {children}
    </ChatSurface>
  )
}

/** K3: l'incavo dentro una card (CardBlock del catalogo), col nome di prima. */
export function CardBlock({ className, testid, children }: {
  className?: string
  testid?: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Block className={className} testId={testid}>
      {children}
    </Block>
  )
}
