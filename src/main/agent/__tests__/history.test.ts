import { describe, expect, it } from 'vitest'
import { buildMessages } from '../history'
import type { TranscriptEntry } from '../../../shared/types'

let nextId = 1
function mk(kind: TranscriptEntry['kind'], role: TranscriptEntry['role'], content: string, meta?: Record<string, unknown>): TranscriptEntry {
  return { id: nextId++, agentId: 'a', kind, role, content, meta: meta ?? null, createdAt: nextId * 1000 }
}

const sys = 'SEI IL SISTEMA'

describe('buildMessages (§5.3)', () => {
  it('ordine cronologico: [system, user, assistant(+toolCalls), tool, user]', () => {
    const entries = [
      mk('message', 'user', 'ciao'),
      mk('message', 'assistant', 'guarda'),
      mk('tool-call', 'assistant', 'run-command', { id: 'call1', name: 'run-command', arguments: '{"command":"ls"}' }),
      mk('tool-result', 'system', 'file1\nfile2', { callId: 'call1' }),
      mk('message', 'assistant', 'ecco i file'),
      mk('message', 'user', 'grazie')
    ]
    const msgs = buildMessages(sys, entries)
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user'])
    expect(msgs[0]).toEqual({ role: 'system', content: sys })
    expect(msgs[2].toolCalls?.[0]).toMatchObject({ id: 'call1', name: 'run-command' })
    expect(msgs[3]).toMatchObject({ role: 'tool', toolCallId: 'call1' })
    expect(msgs[5].content).toBe('grazie')
  })

  it('il messaggio corrente (ultimo entry utente) compare una sola volta', () => {
    const entries = [
      mk('message', 'user', 'prima domanda'),
      mk('message', 'assistant', 'risposta'),
      mk('message', 'user', 'seconda domanda')
    ]
    const msgs = buildMessages(sys, entries)
    const currents = msgs.filter((m) => m.role === 'user' && m.content === 'seconda domanda')
    expect(currents).toHaveLength(1)
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
  })

  it('le immagini si attaccano all’ULTIMO messaggio utente, non agli altri', () => {
    const entries = [
      mk('message', 'user', 'guarda questa foto'),
      mk('message', 'assistant', 'vedo un grafico')
    ]
    const msgs = buildMessages(sys, entries, ['BASE64=='])
    expect(msgs[1].images).toEqual(['BASE64=='])
    expect(msgs[2].images).toBeUndefined()
  })

  it('tool-call multiple della stessa risposta si aggregano in un solo messaggio assistant', () => {
    const entries = [
      mk('message', 'user', 'fai due cose'),
      mk('message', 'assistant', 'ok'),
      mk('tool-call', 'assistant', 'run-command', { id: 'c1', name: 'run-command', arguments: '{}' }),
      mk('tool-call', 'assistant', 'read-file', { id: 'c2', name: 'read-file', arguments: '{}' }),
      mk('tool-result', 'system', 'r1', { callId: 'c1' }),
      mk('tool-result', 'system', 'r2', { callId: 'c2' })
    ]
    const msgs = buildMessages(sys, entries)
    expect(msgs[2].toolCalls?.map((t) => t.id)).toEqual(['c1', 'c2'])
    expect(msgs.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['c1', 'c2'])
  })

  it('il taglio avviene solo a confine di turno', () => {
    // 3 turni; budget 4 messaggi: il suffix deve partire da un messaggio utente
    const entries = [
      mk('message', 'user', 'turno 1'),
      mk('message', 'assistant', 'risp 1'),
      mk('message', 'user', 'turno 2'),
      mk('message', 'assistant', 'risp 2'),
      mk('message', 'user', 'turno 3'),
      mk('message', 'assistant', 'risp 3')
    ]
    const msgs = buildMessages(sys, entries, undefined, { maxMessages: 4 })
    expect(msgs[0].role).toBe('system')
    expect(msgs[1].role).toBe('user') // confine di turno, mai a metà
    expect(msgs[1].content).toBe('turno 2')
    expect(msgs.map((m) => m.content)).toEqual([sys, 'turno 2', 'risp 2', 'turno 3', 'risp 3'])
  })

  it('dopo il taglio nessuna coppia tool orfana: result senza call viene scartato', () => {
    const entries = [
      mk('message', 'user', 't1'),
      mk('tool-call', 'assistant', 'run-command', { id: 'old1', name: 'run-command', arguments: '{}' }),
      mk('tool-result', 'system', 'risultato vecchio', { callId: 'old1' }),
      mk('message', 'assistant', 'vecchia risposta'),
      mk('message', 'user', 't2'),
      mk('message', 'assistant', 'nuova risposta')
    ]
    // budget 2: il suffix parte da 't2' → la coppia old1 sparisce interamente
    const msgs = buildMessages(sys, entries, undefined, { maxMessages: 2 })
    expect(msgs.some((m) => m.role === 'tool')).toBe(false)
    expect(msgs.some((m) => m.role === 'assistant' && m.toolCalls?.length)).toBe(false)
    expect(msgs.map((m) => m.content)).toEqual([sys, 't2', 'nuova risposta'])
  })

  it('tool-call senza result (turno interrotto) → result sintetico "interrupted"', () => {
    const entries = [
      mk('message', 'user', 'esegui'),
      mk('message', 'assistant', 'sto eseguendo'),
      mk('tool-call', 'assistant', 'run-command', { id: 'pending', name: 'run-command', arguments: '{}' })
      // nessun tool-result: il turno era stato interrotto
    ]
    const msgs = buildMessages(sys, entries)
    const last = msgs[msgs.length - 1]
    expect(last.role).toBe('tool')
    expect(last.toolCallId).toBe('pending')
    expect(last.content).toBe('interrupted')
  })

  it('result orfano in testa (call tagliata ma result no) viene scartato', () => {
    // il taglio a confine di turno non lo produce quasi mai, ma il repair deve
    // reggerlo comunque: nessun messaggio tool senza call corrispondente
    const entries = [
      mk('tool-call', 'assistant', 'run-command', { id: 'cut', name: 'run-command', arguments: '{}' }),
      mk('tool-result', 'system', 'r', { callId: 'cut' }),
      mk('message', 'user', 'nuovo turno'),
      mk('message', 'assistant', 'ok')
    ]
    const msgs = buildMessages(sys, entries, undefined, { maxMessages: 3 })
    // il suffix di 3 messaggi parte comunque da un user; il result 'cut' non può restare senza la sua call
    const toolMsgs = msgs.filter((m) => m.role === 'tool')
    for (const t of toolMsgs) {
      const hasCall = msgs.some((m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === t.toolCallId))
      expect(hasCall).toBe(true)
    }
  })

  it('entries noti/approval/event non entrano nella storia', () => {
    const entries = [
      mk('message', 'user', 'ciao'),
      mk('notice', 'system', 'avviso interno'),
      mk('approval', 'system', 'run-command: ls', { approvalId: 'x' }),
      mk('event', 'system', 'status'),
      mk('message', 'assistant', 'risposta')
    ]
    const msgs = buildMessages(sys, entries)
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
  })
})
