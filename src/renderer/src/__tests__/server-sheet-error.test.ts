// N1 (fase mcp-egress-sicurezza): il FOGLIO del server dice quando un server
// npm installato non parte perché il motore del box non garantisce il recinto
// (Docker = internet libera): la riga d'errore dell'ultima prova, in parole.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, textOf, findAll } from './render-helper'
import { setStoreStateForRender } from './render-helper'

const { ServerSheet } = await import('../components/ServerSheet')
const { useStore } = await import('../store')

const RIFIUTO = /unverified npm servers do not start/

function sheetWith(over: Record<string, unknown>): string {
  setStoreStateForRender(useStore, {
    agents: [{ id: 'a-bot', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }]
  })
  const sv = {
    id: 'npm-mattermost-mcp-aabbccdd',
    name: '@donach/mattermost-mcp',
    transport: 'stdio',
    box: { command: 'npx', args: ['--yes', '@donach/mattermost-mcp@2.3.4'] },
    source: { kind: 'npm', package: '@donach/mattermost-mcp', version: '2.3.4' },
    enabledFor: ['a-bot'],
    stateStatus: 'error',
    stateError: 'With the Docker engine the isolated computer has unrestricted internet: unverified npm servers do not start. Use the Apple engine, or import the server from Cursor, Claude or Zcode.',
    ...over
  }
  return renderHtml(createElement(ServerSheet, { sv, onDone: () => undefined }))
}

describe('N1: il foglio del server dice perché non parte', () => {
  it('con stato error la riga mostra la frase del rifiuto in parole', () => {
    const html = sheetWith({})
    const texts = findAll(parseHtml(html), () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toMatch(RIFIUTO)
    expect(texts).toMatch(/Docker/)
  })

  it('senza errore di stato la riga non c\'è', () => {
    const html = sheetWith({ stateStatus: undefined, stateError: undefined })
    const texts = findAll(parseHtml(html), () => true).map((n) => textOf(n)).join('\n')
    expect(texts).not.toMatch(RIFIUTO)
  })
})
