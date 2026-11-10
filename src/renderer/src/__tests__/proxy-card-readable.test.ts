// RW4 (fase revisore sulla richiesta): la card della richiesta diretta
// leggibile. Il titolo NON contiene mai l'endpoint intero (niente query
// string, taglio con «…»), l'endpoint completo compare UNA volta sola (nel
// riquadro degli argomenti) e va a capo, nessuna card allarga la chat.
// Render VERO con react-dom/server; la meta la costruisce il GATE VERO
// (proxyExecuteGate, puro) come fa il daemon.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import type { TranscriptEntry } from '../../../shared/types'
import { renderHtml } from './render-helper'
import { proxyExecuteGate } from '../../../main/connectors/tool-batch'

const { ApprovalCard } = await import('../components/ApprovalCard')

/** l'endpoint del caso vero (entry 273): percorso LUNGO (oltre il taglio del
 *  titolo) e query string — nel render HTML le & diventano &amp; */
const ENDPOINT_PATH = `/1/lists/${'65a1c9f2e8b3d4a5b6c7d8e9f0'.repeat(2)}/cards`
const ENDPOINT =
  `${ENDPOINT_PATH}?filter=all&fields=id,name,idList,dateLastActivity,labels,desc,badges,url,shortUrl&customFieldItems=true`
/** l'endpoint come appare nell'HTML renderizzato (le & escape) */
const ENDPOINT_HTML = ENDPOINT.replaceAll('&', '&amp;')

/** la meta della card come la scrive il loop per una PROXY GET (gate vero) */
function proxyEntry(): TranscriptEntry {
  const outcome = proxyExecuteGate({
    toolName: 'mcp__composio__COMPOSIO_PROXY_EXECUTE',
    args: { toolkit_slug: 'trello', method: 'GET', endpoint: ENDPOINT },
    rules: [], grants: [], uiLang: 'it'
  })
  if (outcome.kind !== 'ask') throw new Error('il gate del PROXY chiede sempre')
  return {
    id: 1, agentId: 'a', kind: 'approval', role: 'system',
    content: 'mcp__composio__COMPOSIO_PROXY_EXECUTE: raw HTTP request', createdAt: 1_700_000_000_000,
    meta: {
      approvalId: 'ap1', tool: 'mcp__composio__COMPOSIO_PROXY_EXECUTE',
      input: { toolkit_slug: 'trello', method: 'GET', endpoint: ENDPOINT },
      status: 'pending',
      composioBatch: {
        actions: outcome.actions, incomplete: outcome.incomplete,
        destructive: outcome.destructive, noAlways: outcome.noAlways, reason: outcome.reason
      },
      composioNoAlways: true,
      composioProxyRead: true
    }
  }
}

const count = (s: string, needle: string): number => s.split(needle).length - 1

describe('RW4 — la card della richiesta diretta leggibile', () => {
  const html = renderHtml(createElement(ApprovalCard, { entry: proxyEntry() }))

  it('il titolo non contiene «?» (niente query string) né l\'endpoint intero', () => {
    const title = html.match(/<p class="[^"]*font-semibold[^"]*"[^>]*>([^<]*)<\/p>/)?.[1] ?? ''
    expect(title).toContain('Trello')
    expect(title).toContain('Richiesta diretta')
    expect(title).not.toContain('?')
    expect(title).not.toContain(ENDPOINT_HTML)
  })

  it('l\'endpoint completo compare UNA volta sola (nel riquadro degli argomenti)', () => {
    expect(count(html, ENDPOINT_HTML)).toBe(1)
    // il percorso intero (quello tagliato nel titolo) sta solo nel riquadro
    expect(count(html, ENDPOINT_PATH)).toBe(1)
    // e nel riquadro va a capo: break-all sulla riga dell'argomento
    expect(html).toMatch(/break-all[^>]*>[^<]*\?filter=all/)
  })

  it('il titolo ha la classe di andata a capo (niente scroll orizzontale)', () => {
    const titleCls = html.match(/<p class="([^"]*font-semibold[^"]*)"/)?.[1] ?? ''
    expect(titleCls).toMatch(/break-all|anywhere/)
  })

  it('il contenitore della card non può allargare la chat (min-w-0 + overflow-wrap)', () => {
    const shellCls = html.match(/<div class="([^"]*rounded-\[18px\][^"]*)"/)?.[1] ?? ''
    expect(shellCls).toContain('min-w-0')
    expect(shellCls).toMatch(/overflow-wrap|anywhere/)
  })
})
