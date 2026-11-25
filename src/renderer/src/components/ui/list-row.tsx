// C1 (fase linguaggio): ListRow — LA riga di elenco dell'app, un solo oggetto
// per ogni elenco: segno · titolo · sottotititolo · metadato · azione. Prende
// il posto di SettingsRow, AppRow, YourRow e delle righe scritte a mano in
// Libreria, Attività e Da approvare: stesse misure ovunque (min-h-row 52 col
// segno, 40 senza; respiro py-row-pad; segno nella casa da 32, così il testo
// parte sempre dalla stessa ascissa).
// Le REGOLE dell'azione: in una riga è sempre Button variant="secondary"
// size="sm"; Switch solo per acceso/spento; i link di testo spariscono.
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * Una riga di elenco. `clickable` (o `onClick`) la rende un bottone — come le
 * righe di sempre, un div con ruolo e tasto, NON un <button>: dentro possono
 * starci interruttori e selettori (HTML valido). `below` sta SOTTO la riga,
 * alla stessa ascissa del titolo (il motivo per esteso di un collegamento
// che non è partito, il conflitto da decidere).
 */
export function ListRow({ segno, titolo, sottotitolo, metadato, azione, below, onClick, clickable, testId, className }: {
  /** il segno che precede il titolo: un'icona, un logo, un puntino, la mascotte */
  segno?: ReactNode
  titolo: ReactNode
  /** la riga grigia sotto il titolo */
  sottotitolo?: ReactNode
  /** il dato grigio a destra, prima dell'azione (la data, il conteggio) */
  metadato?: ReactNode
  /** l'azione a destra: Button secondary sm, Switch, o chi per lei */
  azione?: ReactNode
  /** ciò che sta sotto la riga, all'ascissa del titolo */
  below?: ReactNode
  onClick?(): void
  /** la riga si può aprire: cursore e hover tenue */
  clickable?: boolean
  testId?: string
  className?: string
}): ReactNode {
  const conSegno = segno !== undefined
  const corpo = (
    <>
      {conSegno && <span className="grid size-8 shrink-0 place-items-center">{segno}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium">{titolo}</span>
        {sottotitolo !== undefined && <span className="mt-0.5 block truncate text-small text-muted-foreground">{sottotitolo}</span>}
      </span>
      {metadato !== undefined && <span className="hidden shrink-0 text-caption text-muted-foreground sm:block">{metadato}</span>}
      {azione !== undefined && <span className="flex min-w-0 shrink-0 items-center justify-end gap-2">{azione}</span>}
    </>
  )
  const cls = cn(
    'flex w-full items-center gap-row-gap py-row-pad',
    conSegno ? 'min-h-row' : 'min-h-row-text',
    (clickable || onClick) && 'cursor-pointer transition hover:bg-muted/50',
    className
  )
  const extra = testId ? { 'data-testid': testId } : {}
  const riga = (clickable || onClick)
    ? (
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
          {corpo}
        </div>
      )
    : <div className={cls} {...extra}>{corpo}</div>
  if (below === undefined) return riga
  return (
    <div {...extra}>
      {riga}
      <div className="flex gap-row-gap pb-3">
        {conSegno && <span className="size-8 shrink-0" aria-hidden="true" />}
        <div className="min-w-0 flex-1">{below}</div>
      </div>
    </div>
  )
}
