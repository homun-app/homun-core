// C1 (fase linguaggio): Textarea — l'area di testo del catalogo, gemella
// dell'Input (stesse classi del campo: FIELD_CLASS), che cresce col testo:
// l'altezza minima è una variante chiusa, il resto lo decide il contenuto.
import * as React from 'react'
import { cn } from '../../lib/utils'
import { FIELD_CLASS } from './input'

export type TextareaMin = 'sm' | 'md' | 'lg'

const MIN: Record<TextareaMin, string> = {
  sm: 'min-h-16', // quattro righe corte (la descrizione di una skill)
  md: 'min-h-24', // il corpo di un messaggio (la bozza da confermare)
  lg: 'min-h-40' // le istruzioni lunghe (il codice in markdown)
}

function Textarea({ min = 'sm', className, ...props }: React.ComponentProps<'textarea'> & {
  /** l'altezza minima: sm 64 (default) · md 96 · lg 160 — poi cresce col testo */
  min?: TextareaMin
}) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'w-full resize-y py-2 placeholder:text-muted-foreground',
        MIN[min],
        FIELD_CLASS,
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
