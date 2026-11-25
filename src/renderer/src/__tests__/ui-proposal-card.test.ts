// C1 (fase linguaggio): il rendering di ProposalCard — l'oggetto unico delle
// proposte in chat.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHtml, parseHtml, findAll, textOf } from './render-helper'
/** Il createElement tollerante dei figli come terzo argomento (come gli altri test dei componenti di ui/). */
const ce = (type: unknown, props: Record<string, unknown> | null, figli?: ReactNode): React.ReactElement =>
  createElement(type as never, (props ?? {}) as never, figli)
import { ProposalCard } from '../components/ui/proposal-card'
import { Button } from '../components/ui/button'
import { Text } from '../components/ui/text'

const rootOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(ce(ProposalCard, { testId: 'proposta-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'proposta-prova')[0]!
}

describe('C1: ProposalCard — il bot propone, tu clicchi', () => {
  it('la forma è della card in chat: rounded-surface, fondo tenue, respiro 16, il lungo va a capo DENTRO', () => {
    const c = (rootOf({ testata: 'x' }).attrs.class ?? '').split(/\s+/)
    for (const k of ['rounded-surface', 'bg-muted', 'p-4', 'wrap-anywhere', 'min-w-0']) expect(c).toContain(k)
  })

  it('l\'ordine è quello della proposta: avviso · testata · righe · perché · configurazione · stato · azioni', () => {
    const ordine: string[] = []
    const figli: Array<[string, ReactNode]> = [
      ['avviso', ce('p', { 'data-mark': 'avviso' })],
      ['testata', ce('p', { 'data-mark': 'testata' })],
      ['righe', ce('p', { 'data-mark': 'righe' })],
      ['perché', ce('p', { 'data-mark': 'perché' })],
      ['configurazione', ce('p', { 'data-mark': 'configurazione' })],
      ['stato', ce('p', { 'data-mark': 'stato' })],
      ['azioni', ce('p', { 'data-mark': 'azioni' })]
    ]
    const root = rootOf(Object.fromEntries(figli))
    for (const n of findAll(root, () => true)) {
      const m = n.attrs['data-mark']
      if (m !== undefined) ordine.push(m)
    }
    expect(ordine).toEqual(figli.map(([k]) => k))
  })

  it('le righe della COSA si scrivono col testo del catalogo (grigie, piccole); le azioni in fila in fondo', () => {
    const root = rootOf({
      testata: ce(Text, { weight: 'semibold' }, 'Aggiungi server MCP: Mattermost'),
      righe: ce(Text, { size: 'small', tone: 'muted' }, 'Pubblicato da mattermost (dominio verificato) · remoto'),
      azioni: ce(Button, null, 'Aggiungi')
    })
    expect(textOf(root)).toContain('Aggiungi server MCP: Mattermost')
    expect(textOf(root)).toContain('dominio verificato')
    const bottone = findAll(root, (n) => (n.attrs['data-slot'] ?? '') === 'button')[0]!
    expect((bottone.parent!.attrs.class ?? '').split(/\s+/)).toContain('gap-2')
  })
})
