// Fase design (DS2): Button — il bottone UNICO dell'interfaccia, al posto delle
// pillole scritte a mano pagina per pagina («Aggiungi», «Riprova», le icone
// delle testate), ognuna con le sue misure. Quattro varianti, due altezze
// (32 px: toolbar e righe · 36 px: il default delle azioni), due forme.
// La forma si decide UNA volta per tipo — le azioni principali delle pagine
// sono PILLOLE (primary), ciò che sta dentro una riga o accanto a un titolo è
// RETTANGOLARE (gli altri) — e non bottone per bottone: `shape` serve ai casi
// veri, che sono pochi. Un'eccezione viene dall'app di oggi: il ghost
// solo-icona è tondo come le icone delle testate.
// `icon` fa un quadrato (largo quanto alto, senza respiro laterale): è per i
// bottoni con la sola icona, che hanno un nome accessibile (aria-label).
// Colori: solo token che l'app usa già (foreground, background, muted,
// destructive, ring): chiaro e scuro li portano già.
// L'anello del fuoco SOLO da tastiera (focus-visible:): la variante è
// ridefinita in styles.css (B5) per non scattare dopo un clic del mouse. Una
// classe `focus:` scatterebbe su ogni fuoco, e la guardia lo vieta.
// cva COMPONE le classi per variante; la fusione — l'ultima vince, sui token di
// DS1 come sulla scala di Tailwind — la fa cn, che li conosce.
import * as React from 'react'
import { Slot } from 'radix-ui'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'link'
export type ButtonSize = 'sm' | 'md'
/** pill: rotonda (rounded-full) · control: rettangolare (rounded-control) */
export type ButtonShape = 'pill' | 'control'

export interface ButtonVariantProps {
  variant?: ButtonVariant
  size?: ButtonSize
  shape?: ButtonShape
  /** solo icona: quadrato quanto alto, nessun respiro laterale; l'icona dentro è 16 px */
  icon?: boolean
}

const buttonClasses = cva(
  [
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap font-medium transition',
    'disabled:pointer-events-none disabled:opacity-50',
    // le icone sono 16 px, qualunque taglia portino; il testo è il default
    // dell'interfaccia (14/20) per le QUATTRO varianti a riquadro — il
    // bottone di parole (link) prende la taglia del testo in cui sta
    '[&_svg]:size-4 [&_svg]:shrink-0',
    'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
  ],
  {
    variants: {
      variant: {
        primary: 'bg-foreground text-background hover:opacity-90 text-body',
        secondary: 'bg-muted text-foreground hover:bg-muted/70 text-body',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground text-body',
        destructive: 'bg-destructive text-destructive-foreground hover:opacity-90 text-body',
        // K2 (fase conversione-chat): il bottone di PAROLE — un'azione DENTRO una
        // frase («— chiudi», «· Vedi perché») o un link nel testo («repository»):
        // niente riquadro, la taglia e il peso del testo intorno
        link: 'text-primary underline-offset-2 hover:underline'
      },
      // l'altezza è la misura (h-), non padding + testo: due bottoni affiancati si allineano sempre
      size: { sm: 'h-control-sm', md: 'h-control' },
      shape: { pill: 'rounded-full', control: 'rounded-control' },
      icon: { true: '', false: '' }
    },
    compoundVariants: [
      // con un'etichetta: il respiro laterale cresce con l'altezza…
      { size: 'sm', icon: false, class: 'px-3' },
      { size: 'md', icon: false, class: 'px-4' },
      // …con la sola icona: nessun respiro, la larghezza è l'altezza
      { size: 'sm', icon: true, class: 'w-control-sm' },
      { size: 'md', icon: true, class: 'w-control' },
      // il bottone di parole: via l'altezza, il respiro e il peso del bottone —
      // sta in linea dentro la frase e va a capo con lei
      { variant: 'link', class: 'inline h-auto px-0 font-normal whitespace-normal' }
    ],
    defaultVariants: { variant: 'primary', size: 'md', icon: false }
  }
)

/**
 * La forma quando non è data, decisa una volta per tipo: primary è una pillola;
 * il ghost solo-icona è tondo (le icone delle testate); tutto il resto è
 * rettangolare.
 */
const shapeOf = (variant: ButtonVariant, icon: boolean): ButtonShape =>
  variant === 'primary' || (variant === 'ghost' && icon) ? 'pill' : 'control'

/**
/**
 * Le classi del bottone, da sole (per esempio su un link reso a mano): le
 * stesse di <Button>, forma di tipo compresa.
 */
export function buttonVariants({ variant = 'primary', size = 'md', icon = false, shape, className }: ButtonVariantProps & { className?: string } = {}): string {
  return cn(buttonClasses({ variant, size, icon, shape: shape ?? shapeOf(variant, icon) }), className)
}

/**
 * K3 (fase conversione-chat): il bottone SECONDARIO dentro una card in chat.
 * La card è già `bg-muted`: con il suo fondo di fabbrica il bottone secondary
 * ci sparirebbe dentro. Sulla pagina è un passo più scuro del fondo; sulla
 * card resta un passo più chiaro (fondo card), com'è sempre stato. Si aggiunge
 * a `<Button variant="secondary">` (className) finché le card che lo usano
 * (K4: bozze, domande) non passano a una variante chiusa.
 */
export const SU_CARD = 'bg-card hover:bg-card/80'

export function Button({
  variant = 'primary',
  size = 'md',
  shape,
  icon = false,
  asChild = false,
  type,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & ButtonVariantProps & {
  /** rende il figlio (un link, un componente di routing) con le classi e le prop del bottone */
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : 'button'
  // type="button" quando non è dato: il default di HTML è submit, e dentro un
  // form (il campo di scrittura) un bottone senza tipo INVIA. Con asChild il
  // default lo riceve solo un figlio <button>: un link non ha un tipo.
  const isButton = !asChild || (React.isValidElement(children) && children.type === 'button')
  return (
    <Comp
      data-slot="button"
      type={type ?? (isButton ? 'button' : undefined)}
      className={cn(buttonVariants({ variant, size, shape, icon }), className)}
      {...props}
    >
      {children}
    </Comp>
  )
}
