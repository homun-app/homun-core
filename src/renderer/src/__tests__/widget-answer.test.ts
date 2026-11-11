// B3 (fase beta.4), punto 1: la risposta libera a una domanda. La riga dopo
// la card dice «Hai scritto: Alle 8» (niente lettera né «·» vuoti); con
// un'opzione resta «Hai scelto: B · …». E la risposta NON si ripete come
// bolla utente separata: resta la riga, riapribile. Render vero con
// react-dom/server + funzione pura per la bolla nascosta.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { i18n } from '@lingui/core'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf } from './render-helper'
import { itCatalogEntries } from './po-helper'

i18n.load('it', itCatalogEntries())
i18n.activate('it')

const { WidgetCard } = await import('../components/WidgetCard')
const { widgetDecidedLabel, hidesUserBubble } = await import('../lib/widget-decision')
const { useStore } = await import('../store')

import type { TranscriptEntry } from '../../../shared/types'

const OPTIONS = [
  { label: 'Preparare le fatture', value: 'fatture' },
  { label: 'Rispondere alle email', value: 'email' }
]

function renderResponded(respondedValue: string | string[]): string {
  setStoreStateForRender(useStore, { widgetRespond: () => undefined })
  const entry = {
    id: 7, agentId: 'a', kind: 'send-message', role: 'assistant', content: '', createdAt: 1,
    meta: {
      respondedValue,
      message: { type: 'widget', prompt: 'Per cosa mi vuoi usare?', options: OPTIONS, allowCustom: true }
    }
  } as unknown as TranscriptEntry
  return renderHtml(createElement(WidgetCard, { entry }))
}

describe('B3: la risposta libera — la riga dopo la card', () => {
  it('testo libero → «Hai scritto: Alle 8», senza lettera né «·» vuoti', () => {
    const html = renderResponded('Alle 8')
    expect(html).toContain('Hai scritto: Alle 8')
    expect(html).not.toContain('Hai scelto')
    expect(html).not.toMatch(/·\s*·/)
    expect(html).not.toMatch(/>·</)
  })

  it('un\'opzione → resta «Hai scelto: A · Preparare le fatture» (con la lettera)', () => {
    const html = renderResponded('fatture')
    expect(html).toContain('Hai scelto: A · Preparare le fatture')
    expect(html).not.toContain('Hai scritto')
  })

  it('widgetDecidedLabel (puro): mai «· ·», il testo libero resta se stesso', () => {
    expect(i18n.t(widgetDecidedLabel('Alle 8', OPTIONS))).toBe('Hai scritto: Alle 8')
    expect(i18n.t(widgetDecidedLabel('fatture', OPTIONS))).toBe('Hai scelto: A · Preparare le fatture')
    expect(i18n.t(widgetDecidedLabel(['fatture', 'email'], OPTIONS))).toBe('Hai scelto: A · Preparare le fatture · B · Rispondere alle email')
  })

  it('la risposta NON si ripete come bolla utente: hidesUserBubble (puro)', () => {
    // meta.respondedTo = la risposta vive già nella riga della card
    expect(hidesUserBubble({ role: 'user', meta: { respondedTo: 7 } })).toBe(true)
    // un messaggio normale resta una bolla
    expect(hidesUserBubble({ role: 'user', meta: null })).toBe(false)
    expect(hidesUserBubble({ role: 'assistant', meta: { respondedTo: 7 } })).toBe(false)
  })
})
