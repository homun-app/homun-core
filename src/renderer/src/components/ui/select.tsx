// M8 (fase 0.3.1001): la <select> comune, gemella dell'Input (stessa altezza
// h-9, stesso padding e corpo del testo) — dove un selettore e un campo
// stanno sulla stessa riga, baseline e altezza coincidono. Nessuno stile
// locale nelle pagine: si usa questa.
import * as React from 'react'
import { cn } from '../../lib/utils'

function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:border-destructive',
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
}

export { Select }
