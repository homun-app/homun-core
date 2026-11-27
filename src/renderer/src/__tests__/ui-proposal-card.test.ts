// C1 (fase linguaggio): il rendering di ProposalCard — l'oggetto unico delle
// proposte in chat. K2 (fase conversione-chat): sta sopra ChatCard, il guscio
// di ogni card in chat — la forma e la testata sono del guscio, qui gli slot
// della proposta e il suo ritmo.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { Plug } from 'lucide-react'
import { renderHtml, parseHtml, findAll, textOf, type HtmlNode } from './render-helper'
import { ProposalCard } from '../components/ui/proposal-card'
import { Button } from '../components/ui/button'
import { Text } from '../components/ui/text'
import { Tag } from '../components/ui/tag'

/** Il createElement tollerante dei figli come terzo argomento (come gli altri test dei componenti di ui/). */
const ce = (type: unknown, props: Record<string, unknown> | null, figli?: ReactNode): React.ReactElement =>
  createElement(type as never, (props ?? {}) as never, figli)

const rootOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(ce(ProposalCard, { testId: 'proposta-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'proposta-prova')[0]!
}
const cls = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter(Boolean)

describe('C1: ProposalCard — il bot propone, tu clicchi', () => {
  it('la forma è della card in chat, e la dà ChatCard: rounded-surface, fondo tenue, respiro 16, l’85% della colonna, il lungo va a capo DENTRO', () => {
    const c = cls(rootOf({ titolo: 'x' }))
    for (const k of ['rounded-surface', 'bg-muted', 'p-4', 'wrap-anywhere', 'min-w-0', 'max-w-[85%]']) expect(c).toContain(k)
    // il fondo del guscio si può chiedere: la proposta in attesa
    expect(cls(rootOf({ titolo: 'x', tone: 'waiting' }))).toContain('bg-waiting/10')
  })

  it('l\'ordine è quello della proposta: avviso · testata · righe · perché · configurazione · stato · azioni', () => {
    const figli: Array<[string, ReactNode]> = [
      ['avviso', ce('p', { 'data-mark': 'avviso' })],
      ['titolo', ce('span', { 'data-mark': 'testata' })],
      ['righe', ce('p', { 'data-mark': 'righe' })],
      ['perché', ce('p', { 'data-mark': 'perché' })],
      ['configurazione', ce('p', { 'data-mark': 'configurazione' })],
      ['stato', ce('p', { 'data-mark': 'stato' })],
      ['azioni', ce('p', { 'data-mark': 'azioni' })]
    ]
    const root = rootOf(Object.fromEntries(figli))
    const ordine: string[] = []
    for (const n of findAll(root, () => true)) {
      const m = n.attrs['data-mark']
      if (m !== undefined) ordine.push(m)
    }
    expect(ordine).toEqual(['avviso', 'testata', 'righe', 'perché', 'configurazione', 'stato', 'azioni'])
  })

  it('il ritmo è chiuso: le righe della COSA a 4 px l’una dall’altra; lo stato e il modulo a 12 da ciò che precede; le azioni in fondo, a 16, in fila', () => {
    const root = rootOf({
      titolo: 'x',
      righe: ce('p', { 'data-mark': 'righe' }),
      configurazione: ce('p', { 'data-mark': 'configurazione' }),
      stato: ce('p', { 'data-mark': 'stato' }),
      azioni: ce(Button, null, 'Aggiungi')
    })
    const mark = (m: string): HtmlNode => findAll(root, (n) => n.attrs['data-mark'] === m)[0]!
    for (const k of ['flex', 'flex-col', 'gap-1']) expect(cls(mark('righe').parent!), k).toContain(k)
    for (const m of ['configurazione', 'stato']) expect(cls(mark(m).parent!), m).toContain('mt-1')
    for (const k of ['flex', 'flex-col', 'gap-2']) expect(cls(mark('configurazione').parent!), k).toContain(k)
    const bottone = findAll(root, (n) => (n.attrs['data-slot'] ?? '') === 'button')[0]!
    for (const k of ['mt-2', 'flex', 'flex-wrap', 'items-center', 'gap-2']) expect(cls(bottone.parent!), k).toContain(k)
  })

  it('la testata è quella di ChatCard: il segno (l’icona, qui), il titolo in peso medio, la nota contro il bordo destro', () => {
    const root = rootOf({ icona: Plug, titolo: 'Aggiungi server MCP: Mattermost', nota: ce(Tag, null, 'token scaduto') })
    const testa = root.children[0]!
    expect(textOf(testa)).toBe('Aggiungi server MCP: Mattermosttoken scaduto')
    expect(findAll(testa, (n) => n.tag === 'svg')).toHaveLength(1)
    const titolo = testa.children[1]!.children[0]!
    for (const k of ['text-body', 'font-medium']) expect(cls(titolo), k).toContain(k)
    expect(cls(testa.children[2]!)[0]).toBe('shrink-0')
  })

  it('le righe si scrivono col testo del catalogo (grigie, piccole); il perché in corpo; lo stato nel suo tono', () => {
    const root = rootOf({
      titolo: 'Installa plugin: ricette',
      righe: ce(Text, { size: 'small', tone: 'muted' }, 'fiducia: marketplace ufficiale'),
      perché: ce(Text, null, 'Per salvare le ricette.'),
      stato: ce(Text, { size: 'small', tone: 'ok' }, '✓ Installato — il bot ha ricevuto l’esito')
    })
    expect(textOf(root)).toContain('fiducia: marketplace ufficiale')
    expect(textOf(root)).toContain('Installa plugin: ricette')
    expect(textOf(root)).toContain('Per salvare le ricette.')
    const stato = findAll(root, (n) => n.tag === 'p' && textOf(n) === '✓ Installato — il bot ha ricevuto l’esito')[0]!
    for (const k of ['text-small', 'text-chart-2']) expect(cls(stato), k).toContain(k)
  })

  it('senza slot non nasce nessun involucro vuoto: solo la testata e il corpo dato', () => {
    const root = rootOf({ titolo: 'x' })
    expect(root.children).toHaveLength(1)
  })
})
