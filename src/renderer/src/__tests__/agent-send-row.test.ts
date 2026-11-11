// B3 (fase beta.4), punto 3: i messaggi tra bot nella chat dell'utente
// (send_to_agent) diventano UNA riga sola — «Ha chiesto a Notizie Tech:
// prepara subito il tuo primo riassunto…» (≤ 100 caratteri) — che si apre
// per leggerli interi, come le righe dei tool. Render vero con
// react-dom/server.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll, textOf } from './render-helper'

const { AgentSendRow, askedRowSummary } = await import('../components/AgentSendRow')

const LONG = 'A Notizie Tech — Prova: prepara subito il tuo primo riassunto delle notizie di tecnologia, quello delle otto di domani mattina, e dimmi se ti serve altro.'

describe('B3: il messaggio a un altro bot è UNA riga sola, apribile', () => {
  it('la riga dice «Ha chiesto a …» col testo troncato a ≤ 100 caratteri', () => {
    const html = renderHtml(createElement(AgentSendRow, { name: 'Notizie Tech', content: LONG }))
    expect(html).toContain('Ha chiesto a Notizie Tech:')
    // la riga è un <details> chiuso col testo intero DENTRO (apribile)
    expect(html).toMatch(/<details/)
    expect(html).toContain(LONG)
    // la sintesi è ≤ 100 caratteri (con i puntini se tagliata)
    expect(askedRowSummary(LONG).length).toBeLessThanOrEqual(100)
    expect(askedRowSummary(LONG)).toMatch(/…$/)
    // un testo corto resta intero, senza puntini
    expect(askedRowSummary('prepara il riassunto')).toBe('prepara il riassunto')
  })

  it('la riga si APRE per leggerli interi, come le righe dei tool', () => {
    const tree = parseHtml(renderHtml(createElement(AgentSendRow, { name: 'Notizie Tech', content: LONG })))
    const summary = findAll(tree, (n) => n.tag === 'summary')
    expect(summary).toHaveLength(1)
    expect(textOf(summary[0]!)).toContain('Ha chiesto a Notizie Tech')
    // il testo intero sta nel <pre> del dettaglio
    const pre = findAll(tree, (n) => n.tag === 'pre')
    expect(textOf(pre[0]!)).toContain('quello delle otto di domani mattina')
  })
})
