// Fase design (DS2, per DS1): cn — l'helper che fonde le classi — deve
// CONOSCERE i token con un nome di DS1. tailwind-merge di fabbrica non li
// conosce, e il danno non si vede finché non si guarda l'HTML reso:
//     cn('text-small text-muted-foreground')  →  «text-muted-foreground»
// Per lui ogni text-<nome> che non è una taglia (xs…9xl) è un COLORE: le sei
// dimensioni di DS1 vengono prese per colori, e il secondo cancella il primo.
// La riga di sistema sarebbe uscita a 14 px invece di 13, il bottone dentro un
// testo text-small avrebbe ereditato 13 px. Stessa malattia per i raggi
// (rounded-control non toglie rounded-full) e le distanze con nome (h-control,
// gap-row-gap): non fuse, mai sovrascritte da una className.
// I nomi si leggono da styles.css, dove sta la verità (DS1): un token nuovo in
// @theme che cn non conosce rende rosso questo test.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { twMerge } from 'tailwind-merge'
import { cn } from '../lib/utils'
import { CSS_PATH } from './design-scan'

const CSS = readFileSync(CSS_PATH, 'utf8')
/** Il blocco dei token di DS1 (@theme static in styles.css). */
const THEME = /@theme static \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? ''
/** I nomi con cui DS1 dichiara un token di una scala (--<scala>-<nome>: …). */
const named = (scala: 'text' | 'radius' | 'spacing' | 'w'): string[] =>
  [...THEME.matchAll(new RegExp(`^\\s*--${scala}-([a-z0-9]+(?:-[a-z0-9]+)*):`, 'gm'))].map((m) => m[1]!)

const TESTO = named('text')
const RAGGI = named('radius')
// «block» no: twMerge ha il gruppo inline-* delle misure logiche (inline-size),
// e con «block» nella scala la classe «inline-block» diventerebbe una misura —
// non si fonderebbe più con flex. Il test sotto lo impedisce.
const DISTANZE = named('spacing').filter((n) => n !== 'block')
const LARGHEZZE = named('w')

/**
 * Un campione di classi di FABBRICA (quelle che si usavano prima di DS1 e che
 * i componenti di components/ui usano ancora): su queste cn deve dire quello
 * che dice tailwind-merge di fabbrica. Ci sono dentro, apposta, le classi che
 * PORTANO nel nome una parola di DS1 (block, row, caption, small, page): sono
 * quelle che un nome nuovo nella scala può spostare di gruppo.
 */
const FABBRICA = [
  'flex', 'inline-flex', 'block', 'inline-block', 'inline', 'hidden', 'grid', 'inline-grid', 'table', 'inline-table', 'table-caption', 'table-row', 'table-cell',
  'contents', 'list-item', 'absolute', 'relative', 'fixed', 'sticky', 'static', 'isolate', 'container',
  'flex-1', 'flex-row', 'flex-col', 'flex-row-reverse', 'shrink-0', 'shrink', 'grow', 'basis-4', 'basis-full',
  'grid-cols-2', 'grid-rows-2', 'col-span-2', 'row-span-2', 'auto-cols-min', 'items-center', 'items-start', 'justify-between', 'justify-center',
  'self-start', 'self-stretch', 'content-center', 'content-between', 'gap-2', 'gap-x-2', 'gap-y-2', 'space-x-2', 'space-y-2',
  'p-4', 'px-3', 'py-2', 'pt-1', 'pr-2', 'pb-3', 'pl-4', 'm-2', 'mx-auto', '-m-2', 'mt-4', 'mb-2', 'ml-1', 'mr-3',
  'w-full', 'w-4', 'w-px', 'w-1/2', 'h-4', 'h-px', 'h-full', 'min-h-6', 'min-w-0', 'max-w-lg', 'max-w-full', 'max-w-[calc(100vw-2rem)]', 'size-8', 'size-px',
  'inset-0', 'top-0', 'right-1', 'bottom-2', 'left-3', 'start-0', 'end-1', 'z-10', 'order-2',
  'text-sm', 'text-xs', 'text-base', 'text-lg', 'text-left', 'text-center', 'text-wrap', 'text-nowrap', 'text-balance', 'text-clip', 'text-ellipsis',
  'text-red-500', 'text-foreground/80', 'font-medium', 'font-semibold', 'font-bold', 'font-sans', 'font-mono', 'leading-4', 'leading-tight', 'tracking-wide', 'tracking-normal',
  'whitespace-nowrap', 'whitespace-normal', 'break-words', 'break-all', 'truncate', 'overflow-ellipsis',
  'bg-background', 'bg-card', 'bg-foreground', 'bg-muted/50', 'bg-red-500', 'border', 'border-2', 'border-t', 'border-dashed', 'border-border', 'border-foreground/20',
  'divide-y', 'divide-x', 'outline', 'outline-2', 'outline-none',
  'rounded', 'rounded-md', 'rounded-lg', 'rounded-xl', 'rounded-2xl', 'rounded-full', 'rounded-t-lg', 'rounded-[14px]',
  'ring', 'ring-2', 'ring-ring', 'ring-ring/50', 'ring-offset-2', 'ring-offset-background', 'shadow-md', 'shadow-soft', 'opacity-50', 'opacity-90',
  'blur-sm', 'brightness-90', 'grayscale', 'transition', 'transition-all', 'duration-150', 'ease-in',
  'cursor-pointer', 'cursor-default', 'select-none', 'pointer-events-none', 'resize-none', 'appearance-none', 'accent-primary', 'caret-foreground',
  '[&_svg]:size-4', '[&_svg]:pointer-events-none', '[&>svg]:size-4', '[mask-type:luminance]', '[transform:translateZ(0)]',
  'hover:bg-muted', 'hover:text-foreground', 'focus-visible:ring-2', 'focus-visible:ring-ring', 'disabled:pointer-events-none', 'disabled:opacity-50', 'dark:bg-card',
  'sm:flex-row', 'md:text-base', 'aria-invalid:border-destructive', 'data-[state=open]:bg-accent', 'group-hover:bg-muted', 'peer-focus:ring-2'
]

describe('DS2: cn conosce i token di DS1', () => {
  it('le sei dimensioni di testo sono TAGLIE, non colori: davanti a un colore restano, in qualunque ordine', () => {
    expect(TESTO.length).toBeGreaterThan(0)
    for (const nome of TESTO) {
      expect(cn(`text-${nome} text-muted-foreground`), nome).toBe(`text-${nome} text-muted-foreground`)
      expect(cn(`text-foreground text-${nome}`), nome).toBe(`text-foreground text-${nome}`)
    }
  })

  it('tra taglie vince l’ultima, tra colori vince l’ultimo — e l’una non tocca l’altro', () => {
    for (const nome of TESTO) {
      expect(cn(`text-small text-${nome}`), nome).toBe(`text-${nome}`)
      expect(cn(`text-${nome} text-small`), nome).toBe('text-small')
    }
    expect(cn('text-small text-waiting text-destructive')).toBe('text-small text-destructive')
    expect(cn('text-body hover:text-foreground')).toBe('text-body hover:text-foreground')
  })

  it('i raggi con nome si fondono con gli altri raggi: rounded-control toglie rounded-full, e viceversa', () => {
    expect(RAGGI.length).toBeGreaterThan(0)
    for (const nome of RAGGI) {
      expect(cn(`rounded-full rounded-${nome}`), nome).toBe(`rounded-${nome}`)
      expect(cn(`rounded-${nome} rounded-full`), nome).toBe('rounded-full')
    }
  })

  it('le distanze con nome si fondono con la scala (h-control, gap-row-gap…): l’ultima vince', () => {
    for (const nome of DISTANZE) {
      for (const prefisso of ['h-', 'gap-', 'p-', 'px-', 'mt-', 'w-']) {
        expect(cn(`${prefisso}4 ${prefisso}${nome}`), `${prefisso}${nome}`).toBe(`${prefisso}${nome}`)
        expect(cn(`${prefisso}${nome} ${prefisso}4`), `${prefisso}${nome}`).toBe(`${prefisso}4`)
      }
    }
  })

  it('le tre larghezze del contenuto si fondono con le altre larghezze', () => {
    for (const nome of LARGHEZZE) {
      expect(cn(`max-w-lg max-w-${nome}`), nome).toBe(`max-w-${nome}`)
      expect(cn(`w-full w-${nome}`), nome).toBe(`w-${nome}`)
    }
  })

  it('«block» NON entra nella scala di cn: le classi di fabbrica con quella parola nel nome restano nel loro gruppo', () => {
    // con «block» fra le distanze, twMerge leggerebbe inline-block come «inline-<misura>»
    for (const classe of ['inline-block flex', 'inline-block hidden', 'block inline-block', 'inline-block block', 'block flex']) {
      expect(cn(classe), classe).toBe(twMerge(classe))
    }
    expect(cn('inline-block flex')).toBe('flex')
  })

  it('sulle classi di fabbrica cn dice quello che dice tailwind-merge di fabbrica (un nome di DS1 non sposta una classe di gruppo)', () => {
    for (const a of FABBRICA) {
      expect(cn(a), a).toBe(twMerge(a))
      for (const b of FABBRICA) {
        expect(cn(`${a} ${b}`), `${a} ${b}`).toBe(twMerge(`${a} ${b}`))
      }
    }
  })
})
