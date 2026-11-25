// C1 (fase linguaggio): il rendering di ListRow — la riga di elenco unica.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll, textOf, type HtmlNode } from './render-helper'
import { ListRow } from '../components/ui/list-row'
import { Button } from '../components/ui/button'

const rootOf = (props: Record<string, unknown>): HtmlNode => {
  const tree = parseHtml(renderHtml(createElement(ListRow, { testId: 'riga-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'riga-prova')[0]!
}
const cls = (props: Record<string, unknown>) => (rootOf(props).attrs.class ?? '').split(/\s+/)

describe('C1: ListRow — segno · titolo · sottotitolo · metadato · azione', () => {
  it('col segno la riga è da 52 (min-h-row), senza da 40 (min-h-row-text): il respiro è py-row-pad', () => {
    expect(cls({ titolo: 'x', segno: '•' })).toContain('min-h-row')
    expect(cls({ titolo: 'x' })).toContain('min-h-row-text')
    expect(cls({ titolo: 'x' })).toContain('py-row-pad')
  })

  it('il segno sta nella casa da 32 (il testo parte sempre dalla stessa ascissa); il sottotitolo è la riga grigia', () => {
    const root = rootOf({ titolo: 'Mattermost', segno: 'M', sottotitolo: 'Server MCP · sul Mac' })
    const casa = findAll(root, (n) => (n.attrs.class ?? '').includes('size-8'))[0]!
    expect(textOf(casa)).toBe('M')
    const sotto = findAll(root, (n) => (n.attrs.class ?? '').includes('text-small'))[0]!
    expect(textOf(sotto)).toBe('Server MCP · sul Mac')
    expect(sotto.attrs.class).toContain('text-muted-foreground')
  })

  it('il metadato è grigio ai caption e sta a destra; l\'azione dopo di lui', () => {
    const root = rootOf({ titolo: 'x', metadato: '2 min fa', azione: createElement(Button, { variant: 'secondary', size: 'sm' }, 'Apri') })
    const meta = findAll(root, (n) => textOf(n) === '2 min fa')[0]!
    expect(meta.attrs.class).toContain('text-caption')
    expect(meta.attrs.class).toContain('text-muted-foreground')
    const azione = findAll(root, (n) => (n.attrs['data-slot'] ?? '') === 'button')[0]!
    expect(textOf(azione)).toBe('Apri')
  })

  it('cliccabile: ruolo bottone, tasto, hover tenue SOLO dove si clicca', () => {
    const c = cls({ titolo: 'x', clickable: true })
    expect(c).toContain('cursor-pointer')
    expect(c).toContain('hover:bg-muted/50')
    const root = rootOf({ titolo: 'x', clickable: true })
    expect(root.attrs.role).toBe('button')
    expect(root.attrs.tabindex).toBe('0')
    expect(cls({ titolo: 'x' })).not.toContain('hover:bg-muted/50')
  })

  it('below sta SOTTO la riga, all\'ascissa del titolo (la casa vuota del segno, come la riga)', () => {
    const root = rootOf({ titolo: 'x', segno: 'M', below: 'il motivo per esteso' })
    const testo = textOf(root)
    expect(testo).toContain('il motivo per esteso')
    // nella riga sotto c'è la casa VUOTA da 32 del segno (aria-hidden), poi il testo alla sua ascissa
    const casaVuota = findAll(root, (n) => (n.attrs.class ?? '').includes('size-8') && n.attrs['aria-hidden'] === 'true')
    expect(casaVuota.length).toBeGreaterThanOrEqual(1)
  })
})
