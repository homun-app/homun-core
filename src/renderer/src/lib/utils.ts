import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/*
 * Fase design (DS2): cn — la fusione delle classi — deve CONOSCERE i token con
 * un nome di DS1. twMerge di fabbrica conosce solo la scala di Tailwind: per
 * lui ogni text-<nome> che non è una taglia (xs…9xl) è un COLORE, perciò
 *     twMerge('text-small text-muted-foreground')  →  «text-muted-foreground»
 * la taglia spariva, e una riga dichiarata text-small usciva a 14 px. I raggi
 * (rounded-control non toglieva rounded-full) e le distanze con nome
 * (h-control, gap-row-gap) non erano nemmeno riconosciuti: una className non
 * li sovrascriveva mai. Qui si dice a twMerge quali nomi esistono, per scala:
 * sono quelli di @theme static in styles.css, e lo controlla
 * __tests__/design-cn.test.ts (li legge da lì: un token nuovo che cn non
 * conosce lo rende rosso).
 * «block» (16 px) NON c'è, di proposito: twMerge ha il gruppo inline-* delle
 * misure logiche (inline-size) e con «block» nella scala la classe
 * «inline-block» verrebbe letta come una misura — non si fonderebbe più con
 * flex. Sulle classi di fabbrica l'esito non cambia (stesso test).
 */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      // le sei dimensioni di testo
      text: ['caption', 'small', 'body', 'reading', 'title', 'page'],
      // i due raggi con nome (il terzo, rounded-full, è di fabbrica)
      radius: ['control', 'surface'],
      // le distanze con nome, e le tre larghezze del contenuto (le legge max-w-)
      spacing: ['page-margin', 'page-margin-narrow', 'section', 'section-head', 'row', 'row-text', 'row-pad', 'row-gap', 'control', 'control-sm', 'col-head', 'reading', 'page', 'wide']
    }
  }
})

/** Merge delle classi Tailwind (utility cn dei componenti): l'ultima vince — sui token di DS1 come sulla scala di Tailwind. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs))
}
