// PP4 (fase plugin-pulita): le righe A FILO — il pezzo riusabile con cui la
// pagina Plugin e la sua scheda smettono di essere «un muro di contenitori».
// Nessun fondo, nessun riquadro: le righe si seguono separate da un filetto,
// con respiro verticale (~12px), e l'hover tenue c'è SOLO dove si può cliccare.
// Slot: leading (icona o logo), title, subtitle? (la riga grigia), trailing?
// (l'azione o l'interruttore, a destra). Solo token già usati dall'app
// (border, muted, muted-foreground, foreground): chiaro e scuro. La 0.3.2 lo
// userà nel resto dell'app; SettingsGroup / SettingsRow non si toccano.
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
  const body = (
    <>
      {leading !== undefined && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px]">{title}</span>
        {subtitle !== undefined && <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">{subtitle}</span>}
      </span>
      {trailing !== undefined && <span className="flex min-w-0 shrink-0 items-center justify-end gap-2">{trailing}</span>}
    </>
  )
  const cls = cn('flex w-full items-center gap-3 py-3 text-left', (clickable || onClick) && 'cursor-pointer transition hover:bg-muted/50', className)
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
