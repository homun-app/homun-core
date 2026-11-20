// E4 (fase mcp-env): la card di un server MCP npm mostra i metadati del
// pacchetto (versione FISSATA, autore, data di pubblicazione, download
// settimanali), la fiducia «non verificato», gli host che potrà raggiungere
// e la riga del computer isolato — e NON installa senza clic (nessuna
// chiamata api dal render).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, textOf, findAll } from './render-helper'

const capture = vi.hoisted(() => ({ els: [] as Array<{ type: unknown; props: Record<string, unknown> }> }))
vi.mock('react/jsx-dev-runtime', async (orig) => {
  const m = (await orig()) as Record<string, (...a: unknown[]) => unknown>
  return {
    ...m,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      capture.els.push({ type, props })
      return m.jsxDEV!(type, props, ...rest)
    }
  }
})

const { McpServerCard } = await import('../components/ConnectorCards13')
const { fakeApiCalls } = await import('./render-helper-install')

const entry = {
  id: 7,
  agentId: 'a-1',
  kind: 'send-message',
  role: 'assistant',
  content: '',
  createdAt: 1,
  meta: {
    message: {
      type: 'mcp-server',
      id: 'npm:@donach/mattermost-mcp@2.3.4',
      name: '@donach/mattermost-mcp',
      technicalName: '@donach/mattermost-mcp',
      publisher: 'Donach',
      trust: 'unverified',
      trustKind: 'unverified',
      runtime: { kind: 'box-npm', command: 'npx -y @donach/mattermost-mcp@2.3.4' },
      allowHosts: ['mattermost.competitoor.com'],
      npmMeta: { version: '2.3.4', author: 'Donach', publishedAt: '2026-11-02T10:00:00.000Z', weeklyDownloads: 42017 },
      needs: { kind: 'env', vars: [{ name: 'MATTERMOST_TOKEN', required: true, description: 'Access token' }] },
      thirdPartyWarning: true,
      reason: 'per leggere il canale del tuo team'
    }
  }
} as never

describe('E4: la card del server npm (metadati, host, non verificato, niente install senza clic)', () => {
  it('mostra versione fissata, autore, pubblicazione, download settimanali, gli host e il computer isolato', () => {
    capture.els.length = 0
    const html = renderHtml(createElement(McpServerCard, { entry }))
    const texts = findAll(parseHtml(html), () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('@donach/mattermost-mcp')
    expect(texts).toContain('non verificato')
    expect(texts).toMatch(/2\.3\.4/)
    expect(texts).toMatch(/Donach/)
    expect(texts).toMatch(/42[.,]017|42017/)
    expect(texts).toMatch(/mattermost\.competitoor\.com/)
    expect(texts).toMatch(/computer isolato|computer dei bot/)
    expect(texts).toContain('per leggere il canale del tuo team')
  })

  it('il rendering NON chiama nessuna api (si installa solo al clic)', () => {
    capture.els.length = 0
    fakeApiCalls.length = 0
    renderHtml(createElement(McpServerCard, { entry }))
    expect(fakeApiCalls.length).toBe(0)
  })

  it('senza npmMeta la card resta quella di oggi (nessuna riga npm)', () => {
    const plain = { ...(entry as { meta: { message: Record<string, unknown> } }), meta: { message: { ...((entry as { meta: { message: Record<string, unknown> } }).meta.message), npmMeta: undefined } } } as never
    const html = renderHtml(createElement(McpServerCard, { entry: plain }))
    const texts = findAll(parseHtml(html), () => true).map((n) => textOf(n)).join('\n')
    expect(texts).not.toMatch(/download settimanali|settimanali/)
  })
})
