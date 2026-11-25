// C1 (fase linguaggio): Field — l'etichetta col suo campo: etichetta · campo
// · aiuto · errore. Le pagine non scrivono più la coppia a mano: chiedono il
// pezzo, e l'errore arriva dove deve (sul campo con aria-invalid, in parole
// sotto, nel colore del distruttivo).
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * L'etichetta col campo: `children` è il controllo (Input, Select, Textarea…).
 * L'etichetta è text-small grigia; l'aiuto la frase che spiega; l'errore in
 * parole nel colore del distruttivo, e il campo lo riceve collegato.
 */
export function Field({ label, children, aiuto, errore, htmlFor, className, testId }: {
  /** l'etichetta del campo */
  label: ReactNode
  /** il controllo: Input, Select, Textarea… */
  children: ReactNode
  /** la frase d'aiuto sotto il campo (non l'errore) */
  aiuto?: ReactNode
  /** l'errore: in parole sotto, e il campo lo mostra (aria-invalid) */
  errore?: ReactNode
  /** collega etichetta e campo (l'id del controllo) */
  htmlFor?: string
  className?: string
  testId?: string
}): ReactNode {
  return (
    <div className={cn('flex w-full flex-col gap-1', className)} {...(testId ? { 'data-testid': testId } : {})}>
      <label {...(htmlFor ? { htmlFor } : {})} className="text-small text-muted-foreground">{label}</label>
      {children}
      {aiuto !== undefined && errore === undefined && <p className="text-small text-muted-foreground">{aiuto}</p>}
      {errore !== undefined && (
        <p role="alert" className="text-small text-destructive">{errore}</p>
      )}
    </div>
  )
}
