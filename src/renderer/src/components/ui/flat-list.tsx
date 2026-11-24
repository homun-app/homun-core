// PP4 (fase plugin-pulita): le righe A FILO — il pezzo riusabile con cui la
// pagina Plugin e la sua scheda smettono di essere «un muro di contenitori».
// Nessun fondo, nessun riquadro: le righe si seguono separate da un filetto,
// con respiro verticale, e l'hover tenue c'è SOLO dove si può cliccare.
// Slot: leading (icona o logo), title, subtitle? (la riga grigia), trailing?
// (l'azione o l'interruttore, a destra). Solo token già usati dall'app
// (border, muted, muted-foreground, foreground): chiaro e scuro. La 0.3.2 lo
// userà nel resto dell'app; SettingsGroup / SettingsRow non si toccano.
//
// Fase design (DS2): le misure sono quelle di DS1, che stanno in un posto
// solo (styles.css). Prima erano scritte a mano (15px, 13px, py-3, gap-3) e
// la guardia non le lascia più scrivere. Dalla spec: «riga di elenco: altezza
// minima 52 px (con icona/logo) o 40 px (solo testo), padding verticale
// 12 px, 12 px tra icona e testo»; pesi «500 etichette e titoli di riga».
// PERCHÉ lo slot da 32 (grid size-8) intorno al leading: può essere un'icona
// (size-4) o un logo (size-8) — dentro la stessa casa il testo parte sempre
// dalla stessa ascissa, e la riga non cambia aspetto secondo ciò che le
// passa il chiamante. Lo slot c'è SOLO con il leading, ed è il leading a
// decidere se la riga è da 52 (min-h-row) o da 40 (min-h-row-text).
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/** L'elenco a filo: un filetto tra una riga e l'altra. */
export function FlatList({ children, className, testId }: {
  children: ReactNode
  className?: string
  testId?: string
}): ReactNode {
  return (
    <div className={cn('divide-y divide-border/50', className)} {...(testId ? { 'data-testid': testId } : {})}>
      {children}
    </div>
  )
}

/**
 * Una riga a filo. `clickable` (o `onClick`) la rende un bottone: come le
 * righe di sempre della pagina, un div con ruolo e tasto — non un <button>,
 * perché dentro possono starci interruttori e selettori (un interruttore in
 * un bottone non è HTML valido). Invio e spazio fanno quello che fa il clic.
 */
export function FlatRow({ leading, title, subtitle, trailing, onClick, clickable, testId, className }: {
  leading?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  trailing?: ReactNode
  onClick?(): void
  /** la riga si può aprire: cursore e hover tenue */
  clickable?: boolean
  testId?: string
  className?: string
}): ReactNode {
  const conLeading = leading !== undefined
  const body = (
    <>
      {conLeading && <span className="grid size-8 shrink-0 place-items-center">{leading}</span>}
      <span className="min-w-0 flex-1">
        {/* Stringhe fisse, NON cn(): qui non c'è nulla da fondere, si scrivono
            e basta (una riga grigia resta text-small anche davanti al colore). */}
        <span className="block truncate text-body font-medium">{title}</span>
        {subtitle !== undefined && <span className="mt-0.5 block truncate text-small text-muted-foreground">{subtitle}</span>}
      </span>
      {trailing !== undefined && <span className="flex min-w-0 shrink-0 items-center justify-end gap-2">{trailing}</span>}
    </>
  )
  const cls = cn(
    'flex w-full items-center gap-row-gap py-row-pad',
    conLeading ? 'min-h-row' : 'min-h-row-text',
    (clickable || onClick) && 'cursor-pointer transition hover:bg-muted/50',
    className
  )
  const extra = testId ? { 'data-testid': testId } : {}
  if (clickable || onClick) {
    return (
      <div
        role="button"
        tabIndex={0}
        className={cls}
        {...extra}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick?.()
          }
        }}
      >
        {body}
      </div>
    )
  }
  return <div className={cls} {...extra}>{body}</div>
}
