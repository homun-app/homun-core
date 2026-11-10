// RW (fase revisore sulla richiesta): la riga compressa dell'auto-approvata.
// Con autoBasis 'request' il testo è il reason del revisore («Approvato
// automaticamente: …»); con 'rule' (e per le entry VECCHIE senza autoBasis)
// la regola citata («Approvato automaticamente dalla regola: …»). Lo stesso
// per la bozza auto-inviata. Render VERO con react-dom/server.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import type { TranscriptEntry } from '../../../shared/types'
import { renderHtml } from './render-helper'

const { ApprovalCard } = await import('../components/ApprovalCard')
const { DraftCard } = await import('../components/DraftCard')

const entryOf = (meta: Record<string, unknown>): TranscriptEntry => ({
  id: 1, agentId: 'a', kind: 'approval', role: 'system', content: 'run-command: ls', meta, createdAt: 1_700_000_000_000
})

const draftEntryOf = (meta: Record<string, unknown>): TranscriptEntry => ({
  id: 2, agentId: 'a', kind: 'send-message', role: 'assistant', content: 'ciao', meta, createdAt: 1_700_000_000_000
})

describe('RW1: la riga dell\'auto-approvata distingue basis request e rule', () => {
  it('basis request → «Approvato automaticamente: <reason del revisore>», mai una regola', () => {
    const html = renderHtml(createElement(ApprovalCard, { entry: entryOf({
      tool: 'run-command', input: { command: 'ls' }, status: 'allowed',
      autoApproved: true, autoBasis: 'request', reason: 'lettura che serve alla richiesta'
    }) }))
    expect(html).toContain('Approvato automaticamente: lettura che serve alla richiesta')
    expect(html).not.toContain('dalla regola')
  })

  it('basis rule → «Approvato automaticamente dalla regola: <regola>»', () => {
    const html = renderHtml(createElement(ApprovalCard, { entry: entryOf({
      tool: 'run-command', input: { command: 'ls' }, status: 'allowed',
      autoApproved: true, autoBasis: 'rule', ruleMatched: 'comandi ls dentro la home'
    }) }))
    expect(html).toContain('Approvato automaticamente dalla regola: comandi ls dentro la home')
  })

  it('entry VECCHIA (autoApproved senza autoBasis) → resta la regola, come oggi', () => {
    const html = renderHtml(createElement(ApprovalCard, { entry: entryOf({
      tool: 'run-command', input: { command: 'ls' }, status: 'allowed',
      autoApproved: true, ruleMatched: 'comandi ls dentro la home'
    }) }))
    expect(html).toContain('dalla regola')
  })

  it('bozza auto-inviata con basis request → «Inviata automaticamente: <reason>»', () => {
    const html = renderHtml(createElement(DraftCard, { entry: draftEntryOf({
      status: 'sent', autoApproved: true, autoBasis: 'request', reason: 'era ciò che chiedevi',
      message: { type: 'draft', channel: 'email', to: 'm@example.com', body: 'corpo' }
    }) }))
    expect(html).toContain('Inviata automaticamente: era ciò che chiedevi')
  })

  it('bozza auto-inviata con basis rule → «Inviata automaticamente dalla regola: <regola>»', () => {
    const html = renderHtml(createElement(DraftCard, { entry: draftEntryOf({
      status: 'sent', autoApproved: true, autoBasis: 'rule', ruleMatched: 'comandi ls dentro la home',
      message: { type: 'draft', channel: 'email', to: 'm@example.com', body: 'corpo' }
    }) }))
    expect(html).toContain('Inviata automaticamente dalla regola: comandi ls dentro la home')
  })
})
