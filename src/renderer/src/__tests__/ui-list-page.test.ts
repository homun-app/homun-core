// C2 (fase linguaggio): il rendering di ListPage — il modello della pagina
// di elenco.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement as ce } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { ListPage } from '../components/ui/list-page'
import { SearchField } from '../components/ui/search-field'

describe('C2: ListPage — il modello della pagina di elenco', () => {
  it('sta nel guscio a larghezza UNICA (wide), con la testata di pagina e il corpo che scorre', () => {
    const html = renderHtml(ce(ListPage, { testId: 'lista-prova', titolo: 'Plugin', children: 'il corpo' } as never))
    expect(html).toContain('il corpo')
    const tree = parseHtml(html)
    const guscio = findAll(tree, (n) => n.attrs['data-page-shell'] === 'root')[0]!
    expect(guscio).toBeTruthy()
    // wide: la colonna del corpo è larga al più 1120
    const contenuto = findAll(guscio, (n) => n.attrs['data-page-content'] !== undefined).at(-1)!
    expect(contenuto.attrs.style).toBe('max-width:var(--w-wide)')
    expect(findAll(tree, (n) => n.tag === 'h1').length).toBe(1)
  })

  it('la barra è UNA riga: le schede a sinistra quando ci sono, altrimenti la ricerca', () => {
    const conSchede = renderHtml(ce(ListPage, {
      testId: 'p', titolo: 'Plugin', children: 'x',
      schede: { tabs: [['tutto', 'Tutto'], ['skill', 'Skill']] as never, value: 'tutto', onChange: () => undefined }
    } as never))
    expect(findAll(parseHtml(conSchede), (n) => n.attrs.role === 'tablist').length).toBe(1)
    const conRicerca = renderHtml(ce(ListPage, {
      testId: 'p', titolo: 'Attività', children: 'x',
      ricerca: ce(SearchField, { value: '', onChange: () => undefined })
    } as never))
    expect(findAll(parseHtml(conRicerca), (n) => n.tag === 'input' && n.attrs.type === 'search').length).toBe(1)
  })

  it('mai DUE file di barra: con le schede non c\'è anche la ricerca (la regola è UNA fila)', () => {
    const html = renderHtml(ce(ListPage, {
      testId: 'p', titolo: 'Plugin', children: 'x',
      schede: { tabs: [['tutto', 'Tutto']] as never, value: 'tutto', onChange: () => undefined },
      ricerca: ce(SearchField, { value: '', onChange: () => undefined })
    } as never))
    const tree = parseHtml(html)
    expect(findAll(tree, (n) => n.attrs.role === 'tablist').length).toBe(1)
    expect(findAll(tree, (n) => n.tag === 'input' && n.attrs.type === 'search').length).toBe(0)
  })
})
