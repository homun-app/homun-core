// Test di unità (C7 punto 3): le voci d'invio DENTRO il blocco diventano
// bozze. Il classificatore riconosce un blocco con UNA SOLA voce d'invio come
// invio esterno (così draft:send accetta la via) e la bozza estratta porta i
// campi dalla fieldMap sugli argomenti della VOCE.
import { describe, expect, it } from 'vitest'
import { isExternalSend, draftFromBatchSend, DEFAULT_EXTERNAL_SEND_TOOLS } from '../external-send'

const BATCH = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL'

describe('C7 punto 3 — il blocco con UNA sola voce d’invio è un invio esterno', () => {
  it('isExternalSend: true solo con UNA voce d’invio (e readOnlyHint non conta per il blocco)', () => {
    const args = { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@b.c' } }], sync_response_to_workbench: false }
    expect(isExternalSend(BATCH, undefined, DEFAULT_EXTERNAL_SEND_TOOLS, args)).toBe(true)
    expect(isExternalSend(BATCH, { readOnlyHint: true }, DEFAULT_EXTERNAL_SEND_TOOLS, args)).toBe(true)
  })

  it('due voci, o una voce non d’invio: NON è un invio esterno', () => {
    expect(isExternalSend(BATCH, undefined, DEFAULT_EXTERNAL_SEND_TOOLS, {
      tools: [
        { tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} },
        { tool_slug: 'SLACK_SEND_MESSAGE', arguments: {} }
      ]
    })).toBe(false)
    expect(isExternalSend(BATCH, undefined, DEFAULT_EXTERNAL_SEND_TOOLS, {
      tools: [{ tool_slug: 'GMAIL_LIST_THREADS', arguments: {} }]
    })).toBe(false)
    // senza argomenti (il loop non lo intercetta come invio diretto)
    expect(isExternalSend(BATCH, undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
  })

  it('la via con argomenti come STRINGA JSON conta comunque', () => {
    expect(isExternalSend(BATCH, undefined, DEFAULT_EXTERNAL_SEND_TOOLS, {
      tools: [{ tool_slug: 'SLACK_SEND_MESSAGE', arguments: '{"channel":"#x","text":"ciao"}' }]
    })).toBe(true)
  })
})

describe('C7 punto 3 — la bozza estratta dal blocco', () => {
  it('campi dalla fieldMap sugli argomenti della VOCE; via = il blocco con UNA sola voce e sync false', () => {
    const draft = draftFromBatchSend(BATCH, {
      slug: 'GMAIL_SEND_EMAIL',
      arguments: { to: 'a@b.c', subject: 'Ciao', body: 'testo lungo', is_draft: false }
    })
    expect(draft.type).toBe('draft')
    expect(draft.channel).toBe('email')
    expect(draft.to).toBe('a@b.c')
    expect(draft.subject).toBe('Ciao')
    expect(draft.body).toBe('testo lungo')
    expect(draft.via).toEqual({
      tool: BATCH,
      args: {
        tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@b.c', subject: 'Ciao', body: 'testo lungo', is_draft: false } }],
        sync_response_to_workbench: false
      }
    })
    expect(draft.fieldMap).toEqual({ to: 'to', subject: 'subject', body: 'body' })
    // gli argomenti non mappati restano visibili (D1: nessun campo nascosto)
    expect(draft.extraArgs).toEqual([{ key: 'is_draft', value: 'false' }])
  })

  it('canale dal toolkit (slack), account SEMPRE visibile negli extra', () => {
    const draft = draftFromBatchSend(BATCH, {
      slug: 'SLACK_SEND_MESSAGE',
      arguments: { channel: '#generale', text: 'ciao' },
      account: 'work'
    })
    expect(draft.channel).toBe('slack')
    expect(draft.to).toBe('#generale')
    expect(draft.extraArgs).toEqual([{ key: 'account', value: 'work' }])
  })

  it('senza un campo per il corpo: bodyLocked e corpo di ripiego sul JSON', () => {
    const draft = draftFromBatchSend(BATCH, { slug: 'X_POST_UPDATE', arguments: { id: 7 } })
    expect(draft.bodyLocked).toBe(true)
    expect(draft.body).toBe('{"id":7}')
  })
})

describe('C7 punto 3 — il corpo modificato di una bozza estratta dal blocco', () => {
  it('applyDraftBody scrive DENTRO la voce del blocco, non nel guscio', async () => {
    const { applyDraftBody } = await import('../external-send')
    const draft = draftFromBatchSend(BATCH, {
      slug: 'GMAIL_SEND_EMAIL',
      arguments: { recipient_email: 'a@b.c', subject: 'Ciao', body: 'testo del modello' }
    })
    applyDraftBody(draft, 'testo corretto dall’utente')
    const tools = draft.via!.args.tools as Array<{ arguments: Record<string, unknown> }>
    expect(tools).toHaveLength(1)
    expect(tools[0]!.arguments.body).toBe('testo corretto dall’utente')
    expect(draft.via!.args).not.toHaveProperty('body')
    expect(draft.via!.args.sync_response_to_workbench).toBe(false)
    expect(draft.body).toBe('testo corretto dall’utente')
  })
})
