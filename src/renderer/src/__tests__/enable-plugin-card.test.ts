// V6 (fase stato-vivo): la scheda offer_enable_plugin in chat — logo, nome,
// la riga grigia PL1 «Server MCP · <strada>», la frase del bot e i bottoni
// Attiva / Non ora. La scheda È la richiesta: il click chiama plugins:enable
// e NESSUNA accensione avviene nel renderer (accende il daemon). Il clic è
// il VERO handler del componente renderizzato (capture del runtime JSX).
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, textOf, findAll } from './render-helper'
import { stubApiMethod, callsOf } from './render-helper-install'
import type { TranscriptEntry } from '../../../shared/types'

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

const { EnablePluginCard } = await import('../components/ConnectorCards13')

const entryOf = (meta: Record<string, unknown>): TranscriptEntry =>
  ({ id: 42, agentId: 'a-1', kind: 'send-message', role: 'assistant', content: 'orion-moon', createdAt: 1, updatedAt: 1, meta } as never)

beforeEach(() => {
  capture.els.length = 0
  stubApiMethod('pluginsEnableCard', () => ({ ok: true, status: 'activated' }))
})

describe('V6: EnablePluginCard — la scheda per accendere un plugin spento', () => {
  it('logo, nome, la riga grigia PL1, la frase del bot e i DUE bottoni', () => {
    const html = renderHtml(createElement(EnablePluginCard, { entry: entryOf({ message: { type: 'enable-plugin', pluginId: 'orion-moon', name: 'orion-moon', reason: 'mi serve per la tua richiesta' }, status: 'pending' }) } as never))
    const root = parseHtml(html)
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('orion-moon')
    expect(texts).toContain('mi serve per la tua richiesta')
    expect(texts).toContain('Server MCP · sul Mac')
    expect(texts).toContain('Attiva')
    expect(texts).toContain('Non ora')
  })

  it('il click su Attiva chiama plugins:enable (enable) e NON accende niente nel renderer', () => {
    renderHtml(createElement(EnablePluginCard, { entry: entryOf({ message: { type: 'enable-plugin', pluginId: 'srv-x', name: 'orion-moon', reason: 'x' }, status: 'pending' }) } as never))
    const btn = capture.els.find((e) => e.props['data-testid'] === 'enable-plugin-activate')!
    expect(btn).toBeTruthy()
    const before = callsOf('pluginsEnableCard').length
    ;(btn.props.onClick as () => void)()
    const calls = callsOf('pluginsEnableCard').slice(before)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual(['a-1', 42, 'enable'])
  })

  it('il click su Non ora chiama plugins:enable (not-now)', () => {
    renderHtml(createElement(EnablePluginCard, { entry: entryOf({ message: { type: 'enable-plugin', pluginId: 'srv-x', name: 'orion-moon', reason: 'x' }, status: 'pending' }) } as never))
    const btn = capture.els.find((e) => e.props['data-testid'] === 'enable-plugin-not-now')!
    const before = callsOf('pluginsEnableCard').length
    ;(btn.props.onClick as () => void)()
    expect(callsOf('pluginsEnableCard').slice(before)[0]!.args).toEqual(['a-1', 42, 'not-now'])
  })

  it('la scheda ATTIVATA mostra «Attivo · N strumenti»; quella FALLITA «Non parte · Vedi perché»', () => {
    const ok = renderHtml(createElement(EnablePluginCard, { entry: entryOf({ message: { type: 'enable-plugin', pluginId: 'srv-x', name: 'x', reason: 'x' }, status: 'activated', toolsCount: 9 }) } as never))
    expect(textOf(findAll(parseHtml(ok), (n) => n.attrs['data-testid'] === 'enable-plugin-active')[0]!)).toContain('9')
    const ko = renderHtml(createElement(EnablePluginCard, { entry: entryOf({ message: { type: 'enable-plugin', pluginId: 'srv-x', name: 'x', reason: 'x' }, status: 'failed', category: 'unreachable' }) } as never))
    const texts = findAll(parseHtml(ko), () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('Non parte')
    expect(texts).toContain('Vedi perché')
  })
})
