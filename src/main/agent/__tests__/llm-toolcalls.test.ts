import { describe, expect, it } from 'vitest'
import { mergeToolCallDeltas, toAnthropicMessages } from '../llm'

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

describe('toAnthropicMessages (residuo 2a: mai blocchi text vuoti)', () => {
  it('assistant con solo tool call → solo blocchi tool_use, nessun blocco text', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: 'esegui' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run-command', arguments: '{"command":"ls"}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'ok' }
    ])
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'esegui' }] })
    // solo tool_use: un assistant senza testo non ha blocchi text
    expect(out[1]!.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'run-command', input: { command: 'ls' } }])
    // il tool result torna al modello in un messaggio user (convenzione Anthropic)
    expect(out[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }])
  })

  it('assistant con testo di soli spazi + tool call → blocco text scartato', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: '   ', toolCalls: [{ id: 'c2', name: 'read-file', arguments: '{}' }] }
    ])
    expect(out[0]!.content.every((b) => b.type !== 'text')).toBe(true)
  })

  it('assistant vuoto senza tool call → messaggio scartato del tutto', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: 'ciao' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'ehi' }
    ])
    expect(out.map((m) => (m.content[0] as { text: string }).text)).toEqual(['ciao', 'ehi'])
  })

  it('tool result consecutivi si aggregano nello stesso messaggio user', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: '', toolCalls: [
        { id: 'a', name: 't1', arguments: '{}' }, { id: 'b', name: 't2', arguments: '{}' }
      ] },
      { role: 'tool', toolCallId: 'a', content: 'r1' },
      { role: 'tool', toolCallId: 'b', content: 'r2' }
    ])
    expect(out[1]!.content).toHaveLength(2)
    expect(out[1]!.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'a', content: 'r1' })
  })

  it('il system viene gestito fuori dai messaggi: qui non compare', () => {
    const out = toAnthropicMessages([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'ciao' }])
    expect(out).toHaveLength(1)
  })
})
