// M8 (fase 0.3.1001): la <select> comune, gemella dell'Input (stessa altezza,
// stesso padding e corpo del testo) — dove un selettore e un campo stanno
// sulla stessa riga, baseline e altezza coincidono. Nessuno stile locale
// nelle pagine: si usa questa.
// Fase design (DS1, DS4): le classi sono quelle del campo di sistema
// (FIELD_CLASS in ui/input: 36 px, il raggio dei controlli, text-body;
// l'anello del fuoco solo da tastiera).
import * as React from 'react'
import { cn } from '../../lib/utils'
import { FIELD_CLASS } from './input'

function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn('h-control w-full', FIELD_CLASS, className)}
      {...props}
    >
      {children}
    </select>
  )
}

export { Select }
