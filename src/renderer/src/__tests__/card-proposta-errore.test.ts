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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RADICE } from '../../../__tests__/guardie/sorgenti'
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

/** K3 (a): il testo PIATTO di un pezzo d'HTML (i tag via, i caratteri decodificati). */
const piano = (html: string): string => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
/** La card in errore divisa in due: ciò che si vede (prima dei dettagli tecnici) e ciò che sta DENTRO i «Dettagli tecnici» chiusi. */
const diviso = (card: unknown, entry: TranscriptEntry): [string, string] => {
  const html = renderHtml(createElement(card as never, { entry } as never))
  const i = html.indexOf('<details')
  expect(i, 'la card in errore porta i «Dettagli tecnici»').toBeGreaterThan(-1)
  return [piano(html.slice(0, i)), piano(html.slice(i))]
}

describe('K3 (a): il motivo dell\'errore in italiano; il testo tecnico solo nei «Dettagli tecnici»', () => {
  it('col codice del daemon (meta.errorCode) la card dice la FRASE del catalogo; l\'inglese del daemon («not installable here: …») sta solo nei dettagli', () => {
    const [fuori, dentro] = diviso(McpServerCard, entryOf(SERVER, {
      status: 'error', error: 'not installable here: the entry exposes neither remotes nor npm packages', errorCode: 'proposta.nonInstallabile'
    }))
    expect(fuori).toContain('Non si può installare qui')
    expect(fuori).toContain('chiudi')
    expect(fuori).not.toContain('not installable here')
    expect(dentro).toContain('Dettagli tecnici')
    expect(dentro).toContain('not installable here: the entry exposes neither remotes nor npm packages')
  })

  it('il plugin che non si è scaricato: «Non riuscito: il download non è andato a fondo», il «404» solo nei dettagli', () => {
    const [fuori, dentro] = diviso(PluginInstallProposal, entryOf(PLUGIN, { status: 'error', error: 'plugin download failed: 404 Not Found', errorCode: 'proposta.downloadFallito' }))
    expect(fuori).toContain('Non riuscito: il download non è andato a fondo')
    expect(fuori).not.toContain('plugin download failed')
    expect(dentro).toContain('plugin download failed: 404 Not Found')
  })

  it('senza codice (le entry salvate prima dei codici, o un errore che il daemon non classifica) la frase è generica — «Non riuscito» — e l\'inglese resta solo nei dettagli', () => {
    const [fuori, dentro] = diviso(McpServerCard, entryOf(SERVER, { status: 'error', error: 'registry entry not found: context7' }))
    expect(fuori).toContain('Non riuscito')
    expect(fuori).not.toContain('registry entry not found')
    expect(dentro).toContain('registry entry not found: context7')
    // un codice che il catalogo non conosce non si mostra grezzo
    const [sconosciuto] = diviso(McpServerCard, entryOf(SERVER, { status: 'error', error: 'boom', errorCode: 'proposta.maiVista' }))
    expect(sconosciuto).toContain('Non riuscito')
    expect(sconosciuto).not.toContain('proposta.maiVista')
    expect(sconosciuto).not.toContain('boom')
  })

  it('il daemon assegna il codice DOVE NASCE L\'ERRORE (le famiglie d\'installazione di install.ts): null a chi non conosce, mai un codice a caso', async () => {
    const { installErrorCodeOf } = await import('../../../main/connectors/install')
    expect(installErrorCodeOf('not installable here: the entry exposes neither remotes nor npm packages')).toBe('proposta.nonInstallabile')
    expect(installErrorCodeOf('not installable here: type pypi')).toBe('proposta.nonInstallabile')
    expect(installErrorCodeOf('plugin download failed: 404 Not Found')).toBe('proposta.downloadFallito')
    expect(installErrorCodeOf('plugin re-download failed: ECONNRESET')).toBe('proposta.downloadFallito')
    expect(installErrorCodeOf('registry entry not found: context7')).toBe('proposta.nonTrovata')
    expect(installErrorCodeOf('plugin not found: ricette@homun-skills')).toBe('proposta.nonTrovata')
    expect(installErrorCodeOf("it installs only in the bots' computer (docker mode)")).toBe('proposta.hostSpenti')
    expect(installErrorCodeOf('boom')).toBeNull()
  })

  it('il daemon salva il codice accanto al testo (meta.errorCode) in tutte e due le risoluzioni, e le RPC lo riportano al click (code)', () => {
    const api = readFileSync(join(RADICE, 'src/daemon/api.ts'), 'utf8')
    expect(api.match(/errorCode: /g)?.length).toBe(2)
    const tipi = readFileSync(join(RADICE, 'src/shared/types.ts'), 'utf8')
    for (const firma of ['connectorsResolveMcpServer(', 'pluginsResolve(']) {
      const riga = tipi.split('\n').find((l) => l.includes(firma))!
      expect(riga, firma).toContain('code?: string')
    }
  })
})
