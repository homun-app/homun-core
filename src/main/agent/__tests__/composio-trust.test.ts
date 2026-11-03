// Test di unità (C4): la fiducia PER APP nel turno (Rakazo run-trust.ts:37–53
// e action-approval.ts:258–263) e l'azione negata ripetuta (158–177).
// Tutto PURO.
import { describe, expect, it } from 'vitest'
import {
  connectorReadRequiresApproval, composioTrustKeysOfActions, composioTrustKeyOfToolName,
  repeatsDeniedAction, innerToolSlugs, deniedRepeatRefusal, originalToolNameOf
} from '../composio-trust'

const BATCH = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL'
const BATCH_ALTRO_SERVER = 'mcp__altro__COMPOSIO_MULTI_EXECUTE_TOOL'

describe('C4 punto 1 — la fiducia per app nel turno (lettura)', () => {
  it('prima della contaminazione le letture passano; dopo, solo su app fidate', () => {
    expect(connectorReadRequiresApproval({ tainted: false, trusted: false })).toBe(false)
    expect(connectorReadRequiresApproval({ tainted: true, trusted: false })).toBe(true)
    expect(connectorReadRequiresApproval({ tainted: true, trusted: true })).toBe(false)
  })

  it('la chiave di fiducia è il TOOLKIT, una per azione distinta (un blocco Gmail non rende fidato Slack)', () => {
    expect(composioTrustKeysOfActions(['GMAIL_LIST_THREADS', 'GMAIL_GET_EMAIL', 'SLACK_SEARCH_MESSAGES'])).toEqual(['gmail', 'slack'])
    expect(composioTrustKeyOfToolName('composio__gmail__GMAIL_SEND_EMAIL')).toBe('gmail')
  })
})

describe('C4 punto 2 — l’azione negata ripetuta (Rakazo repeatsDeniedAction)', () => {
  it('un blocco nuovo che contiene uno slug già negato ripete (si rifiuta da solo)', () => {
    const denied = [{ toolName: BATCH, args: { tools: [{ tool_slug: 'NOTION_DELETE_PAGE' }] } }]
    const repeated = repeatsDeniedAction({
      toolName: BATCH,
      args: { tools: [{ tool_slug: 'GMAIL_LIST_THREADS' }, { tool_slug: 'NOTION_DELETE_PAGE' }] },
      denied
    })
    expect(repeated).toBe('NOTION_DELETE_PAGE')
  })

  it('un blocco con SOLO slug diversi NON ripete; il confronto vale per nome originale su qualunque server', () => {
    const denied = [{ toolName: BATCH, args: { tools: [{ tool_slug: 'NOTION_DELETE_PAGE' }] } }]
    expect(repeatsDeniedAction({ toolName: BATCH, args: { tools: [{ tool_slug: 'NOTION_GET_PAGES' }] }, denied })).toBeNull()
    // lo stesso blocco su UN ALTRO server: stesso nome originale → ripete
    expect(repeatsDeniedAction({
      toolName: BATCH_ALTRO_SERVER,
      args: { tools: [{ tool_slug: 'notion_delete_page' }] },
      denied
    })).toBe('NOTION_DELETE_PAGE')
  })

  it('per gli strumenti fuori dal blocco vale il nome intero', () => {
    const denied = [{ toolName: 'composio__gmail__GMAIL_CREATE_DRAFT', args: {} }]
    expect(repeatsDeniedAction({ toolName: 'composio__gmail__GMAIL_CREATE_DRAFT', args: {}, denied })).toBe('composio__gmail__GMAIL_CREATE_DRAFT')
    expect(repeatsDeniedAction({ toolName: 'composio__gmail__GMAIL_SEND_EMAIL', args: {}, denied })).toBeNull()
    // un negato NON-blocco non fa ripetere un blocco (strumenti diversi)
    expect(repeatsDeniedAction({ toolName: BATCH, args: { tools: [{ tool_slug: 'X_Y' }] }, denied })).toBeNull()
  })

  it('il rifiuto che torna al modello', () => {
    expect(deniedRepeatRefusal('NOTION_DELETE_PAGE')).toBe('The user denied NOTION_DELETE_PAGE in this turn; do not retry it.')
  })

  it('innerToolSlugs normalizza in maiuscolo (come Rakazo)', () => {
    expect(innerToolSlugs({ tools: [{ tool_slug: ' gmail_send_email ' }, { arguments: {} }] })).toEqual(['GMAIL_SEND_EMAIL'])
    expect(innerToolSlugs({})).toEqual([])
  })

  it('originalToolNameOf toglie il prefisso mcp__<server>__', () => {
    expect(originalToolNameOf(BATCH)).toBe('COMPOSIO_MULTI_EXECUTE_TOOL')
    expect(originalToolNameOf('composio__x__Y')).toBe('composio__x__Y')
  })
})
