// C2 (fase linguaggio): il rendering di DocumentPage — il modello del documento.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement as ce } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { DocumentPage } from '../components/ui/document-page'

const html = renderHtml(ce(DocumentPage, {
  titolo: 'Il documento', testId: 'doc-prova',
  indietro: { onClick: () => undefined, label: 'Torna alla Libreria' },
  children: 'il corpo del documento'
} as never))

describe('C2: DocumentPage — il documento della Libreria', () => {
  it('larghezza READING (720): il documento si legge, non si elenca', () => {
    const tree = parseHtml(html)
    const guscio = findAll(tree, (n) => n.attrs['data-page-shell'] === 'root')[0]!
    const contenuto = findAll(guscio, (n) => n.attrs['data-page-content'] !== undefined).at(-1)!
    expect(contenuto.attrs.style).toBe('max-width:var(--w-reading)')
  })

  it('il titolo di documento in font-display, con «indietro» tondo in testata, livello 30', () => {
    const tree = parseHtml(html)
    const h1 = findAll(tree, (n) => n.tag === 'h1')[0]!
    expect(h1.attrs.class).toContain('font-display')
    expect(findAll(tree, (n) => n.attrs['aria-label'] === 'Torna alla Libreria').length).toBe(1)
    const guscio = findAll(tree, (n) => n.attrs['data-page-shell'] === 'root')[0]!
    expect(guscio.attrs.class).toContain('z-30')
  })
})
