// M3 (fase beta12-correzioni) · PL1 (fase plugin): la card «Apri Server MCP»
// in chat — quando un connettore manca il bot la emette (tool
// offer_mcp_window, payload send-message type 'mcp-window'); il suo bottone
// apre la PAGINA «Plugin» DIRETTAMENTE nel punto dei server MCP (openPlugin
// {kind:'mcp'}, non più la finestra) e NON collega niente da sola (nessuna
// chiamata api). Il clic qui è il VERO handler del componente renderizzato
// (capture del runtime JSX) e apre davvero lo store.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll } from './render-helper'

const CHAT = fileURLToPath(new URL('../components/Chat.tsx', import.meta.url))
const CARDS = fileURLToPath(new URL('../components/ConnectorCards13.tsx', import.meta.url))

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

const { McpWindowCard } = await import('../components/ConnectorCards13')
const { useStore } = await import('../store')
const { fakeApiCalls } = await import('./render-helper-install')

const entry = {
  id: 42,
  agentId: 'a-1',
  kind: 'send-message',
  role: 'assistant',
  content: '',
  createdAt: 1,
  meta: {
    message: { type: 'mcp-window', service: 'Mattermost', reason: 'per postare nel tuo canale' }
  }
} as never

describe('M3: la card «Apri Server MCP» in chat', () => {
  it('Chat.tsx la rende per i payload type mcp-window', () => {
    const src = readFileSync(CHAT, 'utf8')
    expect(src).toMatch(/message\?\.type === 'mcp-window'/)
    expect(src).toMatch(/<McpWindowCard entry=\{entry\} \/>/)
  })

  it('il bottone apre la pagina Plugin nel punto MCP (pluginOpen + pluginAt) e NON chiama nessuna api', () => {
    capture.els.length = 0
    setStoreStateForRender(useStore, { mcpOpen: false })
    const html = renderHtml(createElement(McpWindowCard, { entry }))
    const root = parseHtml(html)
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    // i testi: il servizio, il rimando a Cursor/Claude, il bottone
    expect(texts).toContain('Mattermost')
    expect(texts).toMatch(/Cursor o Claude/)
    expect(texts).toContain('Apri Server MCP')
    expect(texts).toContain('per postare nel tuo canale')
    // il VERO handler del bottone apre la finestra
    const btn = capture.els.find((e) => typeof e.type === 'string' && (e.type as string) === 'button' && String(e.props['data-testid'] ?? '') === 'mcp-window-card-open')
    expect(btn).toBeDefined()
    expect(useStore.getState().pluginOpen).toBe(false)
    ;(btn!.props.onClick as () => void)()
    expect(useStore.getState().pluginOpen).toBe(true)
    expect(useStore.getState().pluginAt).toEqual({ kind: 'mcp' })
    // la card non collega niente da sola: NESSUNA chiamata api partita dal render o dal clic
    expect(fakeApiCalls.length).toBe(0)
  })
})

describe('M3: la card è nel catalogo UI del daemon (titolo della entry)', () => {
  it('ui-messages ha cardOpenMcpWindow e appendSend la usa per type mcp-window', () => {
    const ui = readFileSync(fileURLToPath(new URL('../../../shared/ui-messages.ts', import.meta.url)), 'utf8')
    expect(ui).toMatch(/cardOpenMcpWindow/)
    const loop = readFileSync(fileURLToPath(new URL('../../../main/agent/loop.ts', import.meta.url)), 'utf8')
    expect(loop).toMatch(/message\.type === 'mcp-window' \? ui\(UI\.cardOpenMcpWindow/)
    // il tipo del payload esiste
    const types = readFileSync(fileURLToPath(new URL('../../../shared/types.ts', import.meta.url)), 'utf8')
    expect(types).toMatch(/type: 'mcp-window'/)
  })
})
