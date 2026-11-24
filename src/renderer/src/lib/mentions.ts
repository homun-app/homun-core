// Fase design (DS4, squadra): le @menzioni DENTRO il markdown. La timeline
// della squadra parla come la chat — ogni messaggio di bot è markdown, reso
// dallo stesso BotMarkdown (DocumentMarkdown) — e prima il testo era nudo,
// spezzato a mano attorno alle menzioni. Ora le menzioni si cercano dentro i
// pezzi di TESTO dell'albero reso: mapText li attraversa e li passa alla
// funzione che fa di una menzione una pillola nel colore del bot menzionato
// (TeamChat). Qui le due funzioni PURE, senza DOM né React renderizzato:
// stesso testo e stessi nomi → stessi pezzi.
import { cloneElement, isValidElement, type ReactNode } from 'react'

/**
 * Il testo a pezzi, con le @menzioni da sole: «ciao @Ana, ok» →
 * [«ciao », «@Ana», «, ok»]. Una menzione è «@» seguito dal nome di un
 * membro, o «@tutti» (che lo è anche se nessun membro si chiama così).
 * VINCE IL NOME PIÙ LUNGO: «@Ana Maria» non diventa «@Ana» seguita da «
 * Maria» — i nomi li ordina questa funzione, chi chiama non deve farlo.
 * Una frase non comincia e non finisce con un pezzo vuoto; il pezzo vuoto
 * FRA DUE MENZIONI ATTACCATE («@Ana@Marco») resta nella lista, e lo salta
 * chi rende. I caratteri speciali di un nome sono TESTO, non espressioni:
 * «A.B» non fa jolly con «AXB». Senza membri il testo resta intero in un
 * pezzo solo.
 */
export function splitMentions(text: string, names: readonly string[]): string[] {
  const lista = names.map((n) => n.trim()).filter((n) => n !== '').sort((a, b) => b.length - a.length)
  if (!lista.length) return [text]
  const alternative = lista.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const pezzi = text.split(new RegExp(`(@(?:${alternative}|tutti))`, 'g'))
  // il pezzo che split mette prima di una menzione in cima, o dopo una in fondo, non è un pezzo della frase
  if (pezzi.length > 1 && pezzi[0] === '') pezzi.shift()
  if (pezzi.length > 1 && pezzi[pezzi.length - 1] === '') pezzi.pop()
  return pezzi
}

/**
 * I pezzi di TESTO di un albero reso passano da `fn`; tutto il resto resta
 * com'è. Le stringhe passano dalla funzione; numeri, valori logici e vuoti
 * restano; gli array si scorrono pezzo per pezzo e restano PIATTI (se la
 * funzione dà una lista — i pezzi di una frase — i pezzi finiscono in ordine
 * accanto agli altri, non in una lista dentro la lista); dentro un elemento
 * i figli-testo diventano ciò che restituisce la funzione e L'ELEMENTO resta
 * lo stesso (stesso tipo, stesse prop: ci cambia solo il contenuto).
 */
export function mapText(node: ReactNode, fn: (text: string) => ReactNode): ReactNode {
  if (typeof node === 'string') return fn(node)
  if (Array.isArray(node)) return node.flatMap((n) => inLista(mapText(n, fn)))
  if (isValidElement(node)) {
    const children = (node.props as { children?: ReactNode }).children
    if (children === undefined) return node
    return cloneElement(node, undefined, mapText(children, fn))
  }
  return node
}

/** Un nodo come lista piatta: una lista resta lista (e le liste dentro si aprono), il resto è una lista di uno. */
function inLista(node: ReactNode): ReactNode[] {
  return Array.isArray(node) ? node.flatMap(inLista) : [node]
}
