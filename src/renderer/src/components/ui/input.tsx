// Fase design (DS1, DS4): il CAMPO di testo dell'interfaccia — un controllo
// (36 px di default, h-control; nelle righe delle impostazioni 32, con una
// classe in più che vince), il raggio dei controlli, il testo del corpo. Le
// pagine non gli scrivono stile locale: al più la misura (h-control-sm) e la
// larghezza. L'anello del fuoco solo da tastiera (focus-visible:), lo stesso
// del pezzo Button.
import * as React from 'react'
import { cn } from '../../lib/utils'

/** Le classi del campo: le stesse per Input e Select, così su una riga hanno la stessa altezza e lo stesso corpo del testo. */
export const FIELD_CLASS =
  'flex min-w-0 rounded-control border border-input bg-transparent px-3 text-body shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-control w-full py-1 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-medium file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground',
        FIELD_CLASS,
        className
      )}
      {...props}
    />
  )
}

export { Input }
