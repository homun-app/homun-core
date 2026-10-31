import { describe, expect, it } from 'vitest'
import { mergeToolCallDeltas } from '../llm'
import { toPiContext } from '../llm-pi'

describe('mergeToolCallDeltas (§5.4)', () => {
  it('due tool call nello stesso chunk vengono accumulate entrambe, ordinate per index', () => {
    const acc = new Map()
    const out = mergeToolCallDeltas(acc, [
      { index: 0, id: 'call_a', function: { name: 'read-file', arguments: '{"path":"/a"}' } },
      { index: 1, id: 'call_b', function: { name: 'run-command', arguments: '{"command":"ls"}' } }
    ])
    expect(out).toEqual([
      { id: 'call_a', name: 'read-file', args: '{"path":"/a"}' },
      { id: 'call_b', name: 'run-command', args: '{"command":"ls"}' }
    ])
  })

  it('argomenti frammentati su più chunk si ricompongono per index', () => {
    const acc = new Map()
    mergeToolCallDeltas(acc, [{ index: 0, id: 'call_1', function: { name: 'write-file', arguments: '{"path":"' } }])
    mergeToolCallDeltas(acc, [{ index: 0, function: { arguments: '/x.txt","content":"' } }])
    mergeToolCallDeltas(acc, [{ index: 0, function: { arguments: 'ciao"}' } }])
    const out = mergeToolCallDeltas(acc, [])
    expect(out).toEqual([{ id: 'call_1', name: 'write-file', args: '{"path":"/x.txt","content":"ciao"}' }])
  })

  it('due tool call frammentate in parallelo su più chunk restano separate', () => {
    const acc = new Map()
    mergeToolCallDeltas(acc, [
      { index: 0, id: 'c0', function: { name: 'read-file', arguments: '{"pa' } },
      { index: 1, id: 'c1', function: { name: 'list-directory', arguments: '{"p' } }
    ])
    mergeToolCallDeltas(acc, [
      { index: 1, function: { arguments: 'ath":"."}' } },
      { index: 0, function: { arguments: 'th":"/b"}' } }
    ])
    const out = mergeToolCallDeltas(acc, [])
    expect(out).toEqual([
      { id: 'c0', name: 'read-file', args: '{"path":"/b"}' },
      { id: 'c1', name: 'list-directory', args: '{"path":"."}' }
    ])
  })

  it('index mancante → slot 0; id impostato una volta non si duplica', () => {
    const acc = new Map()
    mergeToolCallDeltas(acc, [{ id: 'x', function: { name: 'ls', arguments: '{}' } }])
    mergeToolCallDeltas(acc, [{ id: 'x', function: { arguments: ' ' } }]) // id rispedito uguale
    expect(mergeToolCallDeltas(acc, [])).toEqual([{ id: 'x', name: 'ls', args: '{} ' }])
  })

  it('senza delta non tocca nulla e ordina comunque per index', () => {
    const acc = new Map()
    mergeToolCallDeltas(acc, [{ index: 2, id: 'c2', function: { name: 'b', arguments: '2' } }])
    mergeToolCallDeltas(acc, [{ index: 1, id: 'c1', function: { name: 'a', arguments: '1' } }])
    const out = mergeToolCallDeltas(acc, [])
    expect(out.map((o) => o.id)).toEqual(['c1', 'c2'])
  })
})

// Fase 18a (E3): i test di toAnthropicMessages (cancellata con gli SDK)
// diventano test della conversione E2.3 (toPiContext) sugli stessi casi.
describe('toPiContext (E2.3: la conversione ChatMessage[] → Context pi-ai)', () => {
  const cur = { api: 'openai-completions', provider: 'test-provider', model: 'test-model' }

  it('assistant con solo tool call → nessun blocco text, argomenti parsati (rotto → {})', () => {
    const { messages } = toPiContext([
      { role: 'user', content: 'esegui' },
      { role: 'assistant', content: '', toolCalls: [
        { id: 'c1', name: 'run-command', arguments: '{"command":"ls"}' },
        { id: 'c2', name: 'read-file', arguments: '{rotto' }
      ] }
    ], [], cur)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user' })
    const a = messages[1] as unknown as { role: string; content: Array<{ type: string }>; stopReason: string }
    expect(a.role).toBe('assistant')
    // solo toolCall: un assistant senza testo non ha blocchi text
    expect(a.content.map((b) => b.type)).toEqual(['toolCall', 'toolCall'])
    expect(a.stopReason).toBe('toolUse')
    expect((a.content[0] as unknown as { arguments: unknown }).arguments).toEqual({ command: 'ls' })
    // argomento JSON rotto → {} (come safeParse di sempre)
    expect((a.content[1] as unknown as { arguments: unknown }).arguments).toEqual({})
  })

  it("assistant con testo di soli spazi e nessuna tool call → niente blocchi text, stopReason 'stop'", () => {
    const { messages } = toPiContext([{ role: 'assistant', content: '   ' }], [], cur)
    const a = messages[0] as unknown as { content: unknown[]; stopReason: string }
    expect(a.content.every((b) => (b as { type: string }).type !== 'text')).toBe(true)
    expect(a.stopReason).toBe('stop')
  })

  it('il toolResult porta toolCallId e il toolName della chiamata con quell\'id (o unknown)', () => {
    const { messages } = toPiContext([
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 't1', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'a', content: 'r1' },
      { role: 'tool', toolCallId: 'zzz', content: 'r2' }
    ], [], cur)
    const r1 = messages[1] as unknown as { role: string; toolCallId: string; toolName: string; isError: boolean; content: unknown[] }
    const r2 = messages[2] as unknown as { toolName: string }
    expect(r1).toMatchObject({ role: 'toolResult', toolCallId: 'a', toolName: 't1', isError: false })
    expect(r1.content).toEqual([{ type: 'text', text: 'r1' }])
    expect(r2.toolName).toBe('unknown')
  })

  it('i system diventano systemPrompt (più di uno: uniti con riga vuota, in ordine)', () => {
    const c1 = toPiContext([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'ciao' }], [], cur)
    expect(c1.systemPrompt).toBe('SYS')
    expect(c1.messages).toHaveLength(1)
    const c2 = toPiContext([
      { role: 'system', content: 'PRIMO' }, { role: 'system', content: 'SECONDO' }, { role: 'user', content: 'x' }
    ], [], cur)
    expect(c2.systemPrompt).toBe('PRIMO\n\nSECONDO')
    expect(c2.messages.every((m) => m.role !== 'system')).toBe(true)
  })

  it('le immagini diventano content parts image (base64 PNG), dopo il testo', () => {
    const { messages } = toPiContext([{ role: 'user', content: 'guarda', images: ['AAA', 'BBB'] }], [], cur)
    const u = messages[0] as unknown as { content: Array<Record<string, unknown>> }
    expect(u.content).toEqual([
      { type: 'text', text: 'guarda' },
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
      { type: 'image', data: 'BBB', mimeType: 'image/png' }
    ])
  })

  it('i tool diventano Tool pi-ai con lo schema JSON passato intatto', () => {
    const params = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
    const { tools } = toPiContext([], [{ name: 'run-command', description: 'run', parameters: params }], cur)
    expect(tools).toEqual([{ name: 'run-command', description: 'run', parameters: params }])
  })
})
