// C1 (fase linguaggio): PageToolbar — la barra degli strumenti della pagina:
// la ricerca a SINISTRA, le pillole di filtro accanto, lo slot della vista a
// destra (le schede, il bottone che cambia rappresentazione). È la riga FERMA
// sopra il corpo: la pagina la riempie, non la disegna (l'involucro con il
// margine lo dà PageShell).
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/** La barra: ricerca · pillole · vista, tutti facoltativi tranne la ricerca. */
export function PageToolbar({ ricerca, pillole, vista, className, testId }: {
  /** la ricerca (SearchField), a sinistra */
  ricerca?: ReactNode
  /** le pillole di filtro (FilterChips), accanto alla ricerca */
  pillole?: ReactNode
  /** lo slot della vista a destra: le schede, il cambio di rappresentazione */
  vista?: ReactNode
  className?: string
  testId?: string
}): ReactNode {
  return (
    <div className={cn('flex min-h-10 w-full items-center gap-3', className)} {...(testId ? { 'data-testid': testId } : {})}>
      {ricerca}
      {pillole !== undefined && <div className="flex min-w-0 flex-wrap items-center gap-2">{pillole}</div>}
      {vista !== undefined && <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2 pl-3">{vista}</div>}
    </div>
  )
}
