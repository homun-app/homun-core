import { describe, expect, it } from 'vitest'
import { mergeToolCallDeltas } from '../llm'

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
