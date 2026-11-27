// K2 (fase conversione-chat): il difetto visto in K1 — una card di proposta in
// errore, quando risale dal transcript, mostrava solo «✕ — chiudi»: il motivo
// era andato perduto. Il daemon lo salva nel meta dell'entry (status 'error',
// error: il testo) e la card lo deve DIRE: il testo com'è, oppure — se è un
// CODICE del catalogo UI ({id, values}, come meta.ui) — nella lingua attiva.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, textOf } from './render-helper'
import { stubApiMethod } from './render-helper-install'
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

const { McpServerCard, PluginInstallProposal } = await import('../components/ConnectorCards13')
const { erroreOfMeta } = await import('../lib/ui-text')

const SERVER = {
  type: 'mcp-server', id: 'registry:context7', name: 'Context7', trust: 'non verificato',
  runtime: { kind: 'remote', host: 'mcp.context7.com' }, needs: { kind: 'oauth' }
}
const PLUGIN = {
  type: 'plugin', id: 'plugin:ricette@homun-skills', name: 'ricette', marketplace: 'homun-skills', trust: 'non verificato',
  skills: [], servers: [], settings: [], ignored: []
}

/** La riga del transcript di una card «send-message», come la salva il daemon dopo il click. */
const entryOf = (message: Record<string, unknown>, extra: Record<string, unknown>): TranscriptEntry =>
  ({ id: 5, agentId: 'a-1', kind: 'send-message', role: 'assistant', content: '', createdAt: 1, meta: { message, ...extra } }) as never

/** Il testo della card resa dal transcript (nessun click: è la RIAPERTURA della chat). */
const testo = (card: unknown, entry: TranscriptEntry): string =>
  textOf(parseHtml(renderHtml(createElement(card as never, { entry } as never))))

beforeEach(() => {
  capture.els.length = 0
  stubApiMethod('connectorsResolveMcpServer', () => ({ ok: true }))
  stubApiMethod('pluginsResolve', () => ({ ok: true }))
})

describe('K2: la card di proposta in errore dice il MOTIVO', () => {
  it('McpServerCard: la card in errore che risale dal transcript dice il testo che il daemon ha salvato in meta.error', () => {
    const t = testo(McpServerCard, entryOf(SERVER, { status: 'error', error: 'registry entry not found: context7' }))
    expect(t).toContain('registry entry not found: context7')
    expect(t).toContain('chiudi')
  })

  it('PluginInstallProposal: lo stesso, per il plugin che non si è installato', () => {
    const t = testo(PluginInstallProposal, entryOf(PLUGIN, { status: 'error', error: 'plugin download failed: 404' }))
    expect(t).toContain('plugin download failed: 404')
    expect(t).toContain('chiudi')
  })

  it('se il motivo è un CODICE del catalogo UI ({id, values}), la card lo dice nella lingua attiva', () => {
    const t = testo(McpServerCard, entryOf(SERVER, { status: 'error', error: { id: 'sistema.serverAddFailed', values: { name: 'Context7', error: 'boom' } } }))
    expect(t).toContain('Server "Context7" NON aggiunto: boom')
  })

  it('senza alcun motivo salvato (le entry vecchie) la card non resta muta: dice «Non riuscito» prima di «chiudi»', () => {
    const t = testo(PluginInstallProposal, entryOf(PLUGIN, { status: 'error' }))
    expect(t).toContain('Non riuscito')
    expect(t).toContain('chiudi')
  })

  it('erroreOfMeta: il testo com\'è · il codice tradotto · null senza errore (così la card usa il risultato del click, o la frase di ripiego)', () => {
    expect(erroreOfMeta({ error: 'boom' })).toBe('boom')
    expect(erroreOfMeta({ error: '   ' })).toBeNull()
    expect(erroreOfMeta({ status: 'error' })).toBeNull()
    expect(erroreOfMeta(undefined)).toBeNull()
    expect(erroreOfMeta({ error: { id: 'sistema.pluginInstallFailed', values: { name: 'ricette', error: '404' } } })).toBe('Plugin "ricette" NON installato: 404')
  })
})
