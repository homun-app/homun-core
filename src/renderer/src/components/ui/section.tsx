// Fase design (DS2): LA SEZIONE — titolo · azione a destra · contenuto — con
// le distanze dei token (DS1): dal titolo al contenuto 12 px
// (gap-section-head), fra i blocchi dentro la sezione 16 px (gap-block).
//
// Il titolo ha tre misure, non di più:
//   caption (il default)  text-caption grigio, 500 — le etichette di gruppo:
//                         si leggono come intestazioni, non come titoli
//   body                  text-body grigio, 500 — quando il gruppo deve
//                         pesare di più
//   title                 text-title in primo piano, 600 — i titoli di
//                         sezione grandi Bricolage Grotesque (font-display) non compare: è solo del titolo di pagina
// e dei titoli dei documenti.
//
// NESSUN MARGINE ESTERNO, di proposito. La distanza fra una sezione e l'altra
// (32 px, gap-section) la decide chi le elenca, mettendole in un contenitore
// `flex flex-col gap-section` (in una pagina: contentClassName di PageShell).
// Se ogni sezione portasse il suo margine, il primo e l'ultimo elemento
// dell'elenco avrebbero uno spazio che non serve (o bisognerebbe toglierlo
// con first: e last:), e due sezioni vicine farebbero doppio spazio.
//
// `className` è per ciò che la sezione È nel suo posto (per esempio una
// scheda: rounded-surface bg-card p-4), non per le distanze: quelle sono qua.
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/** Le tre misure del titolo: dimensione, peso, colore. */
const TITLE = {
  caption: 'text-caption font-medium text-muted-foreground',
  body: 'text-body font-medium text-muted-foreground',
  title: 'text-title font-semibold text-foreground'
} as const

export function Section({ title, action, children, size = 'caption', className, testId }: {
  /** il titolo della sezione; senza, la riga di testa c'è solo se c'è l'azione */
  title?: ReactNode
  /** l'azione a destra sulla riga del titolo (un bottone, un link): non si restringe mai */
  action?: ReactNode
  /** i blocchi della sezione: stanno a 16 px l'uno dall'altro */
  children: ReactNode
  /** la misura del titolo (vedi in cima): caption, body o title */
  size?: 'caption' | 'body' | 'title'
  /** classi in più per la radice: ciò che la sezione è nel suo posto, non le distanze */
  className?: string
  /** il testid della sezione */
  testId?: string
}): ReactNode {
  return (
    <section className={cn('flex flex-col gap-section-head', className)} {...(testId ? { 'data-testid': testId } : {})}>
      {(title !== undefined || action !== undefined) && (
        <div className="flex items-center gap-3">
          {title !== undefined && <h2 className={TITLE[size]}>{title}</h2>}
          {/* ml-auto: l'azione sta contro il bordo destro, con il titolo lungo a piacere */}
          {action !== undefined && <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      <div className="flex flex-col gap-block">{children}</div>
    </section>
  )
}
