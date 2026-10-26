import { describe, expect, it } from 'vitest'
import { buildMessages, visibleReplyEntries } from '../history'
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

  it('residuo 2a: assistant vuoto senza tool call (stream interrotto) viene scartato', () => {
    const entries = [
      mk('message', 'user', 'ciao'),
      mk('message', 'assistant', ''),           // stream interroto prima di un token
      mk('message', 'assistant', '   '),        // solo spazi: stessa cosa
      mk('message', 'user', 'ancora ciao'),
      mk('message', 'assistant', 'ecco')
    ]
    const msgs = buildMessages(sys, entries)
    expect(msgs.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['ecco'])
    // nessun assistant con contenuto vuoto o di soli spazi
    for (const m of msgs) if (m.role === 'assistant') expect(m.content.trim()).not.toBe('')
  })

  it('residuo 2a: assistant vuoto seguito da tool-call → assistant con SOLO la chiamata', () => {
    const entries = [
      mk('message', 'user', 'esegui'),
      mk('message', 'assistant', ''), // il modello è passato dritto alla tool call
      mk('tool-call', 'assistant', 'run-command', { id: 'c9', name: 'run-command', arguments: '{}' }),
      mk('tool-result', 'system', 'ok', { callId: 'c9' })
    ]
    const msgs = buildMessages(sys, entries)
    const asst = msgs.find((m) => m.role === 'assistant' && m.toolCalls?.length)
    expect(asst?.content).toBe('') // contenuto testo assente: solo tool_use
    expect(asst?.toolCalls?.[0]?.id).toBe('c9')
  })
})

describe('fase 3 (§3bis L2): send-message e thinking nella storia del modello', () => {
  it('send-message text → tool call send_to_user + tool result, non testo assistant', () => {
    const entries = [
      mk('message', 'user', 'ciao'),
      mk('thinking', 'assistant', 'ragiono tra me'),
      mk('send-message', 'assistant', 'Ecco la risposta', {
        call: { id: 'call_1', name: 'send_to_user', arguments: '{"text":"Ecco la risposta"}' },
        message: { type: 'text', text: 'Ecco la risposta' }
      }),
      mk('message', 'user', 'grazie')
    ]
    const sentId = entries[2]!.id
    const msgs = buildMessages(sys, entries)
    // thinking resta contenuto assistant…
    expect(msgs[2]).toMatchObject({ role: 'assistant', content: 'ragiono tra me' })
    // …e la send-message aggrega la sua call su quel messaggio assistant
    expect(msgs[2].toolCalls?.[0]).toMatchObject({ id: `send_${sentId}`, name: 'send_to_user', arguments: '{"text":"Ecco la risposta"}' })
    expect(msgs[3]).toEqual({ role: 'tool', toolCallId: `send_${sentId}`, content: "inviato all'utente" })
    expect(msgs[4]).toEqual({ role: 'user', content: 'grazie' })
  })

  it('widget → call ask_user con esito "in attesa"; respondedValue/dismissed cambiano il result', () => {
    const base = (extra: Record<string, unknown>): TranscriptEntry => mk('send-message', 'assistant', 'Sì o no?', {
      call: { id: 'w', name: 'ask_user', arguments: '{"prompt":"Sì o no?"}' },
      message: { type: 'widget', prompt: 'Sì o no?', options: [{ label: 'Sì', value: 'si' }] },
      ...extra
    })
    const user = mk('message', 'user', 'x')
    const widget = base({})
    const waiting = buildMessages(sys, [user, widget])
    expect(waiting[2]).toMatchObject({ role: 'assistant', content: '', toolCalls: [{ name: 'ask_user' }] })
    expect(waiting[3]).toMatchObject({ role: 'tool', toolCallId: `send_${widget.id}` })
    expect(waiting[3]?.content).toContain("turno terminato in attesa della risposta")

    const answered = buildMessages(sys, [mk('message', 'user', 'x'), base({ respondedValue: 'si' })])
    expect(answered[3]?.content).toContain('utente ha risposto: "si"')

    const dismissed = buildMessages(sys, [mk('message', 'user', 'x'), base({ widgetDismissed: true })])
    expect(dismissed[3]?.content).toContain('scartato')
  })

  it('bozza → call originale (meta.call) con esito dello stato; thinking vuoto escluso', () => {
    const entries = [
      mk('message', 'user', 'scrivi a x'),
      mk('thinking', 'assistant', ''),
      mk('send-message', 'assistant', 'Oggetto', {
        call: { id: 'd1', name: 'mcp__gmail__send_message', arguments: '{"to":"x@y.it"}' },
        message: { type: 'draft', channel: 'email', to: 'x@y.it', body: 'ciao', via: { tool: 'mcp__gmail__send_message', args: { to: 'x@y.it' } } },
        status: 'sent'
      })
    ]
    const draftId = entries[2]!.id
    const msgs = buildMessages(sys, entries)
    // thinking vuoto scartato; la call è quella ORIGINALE del modello
    expect(msgs.filter((m) => m.role === 'assistant' && m.content)).toHaveLength(0)
    expect(msgs[2]).toMatchObject({ role: 'assistant', content: '', toolCalls: [{ id: `send_${draftId}`, name: 'mcp__gmail__send_message' }] })
    expect(msgs[3]).toMatchObject({ role: 'tool', toolCallId: `send_${draftId}`, content: "bozza inviata all'utente che l'ha confermata" })
  })

  it('send-message senza meta.call ricade sul tool del payload (ask_user/draft_external/send_to_user)', () => {
    const entries = [
      mk('send-message', 'assistant', 'domanda?', { message: { type: 'widget', prompt: 'domanda?', options: [] } })
    ]
    const msgs = buildMessages(sys, entries)
    expect(msgs[1]?.toolCalls?.[0]).toMatchObject({ name: 'ask_user' })
  })

  it('visibleReplyEntries: estrae i messaggi visibili da una sequenza di tool call', () => {
    const entries = [
      mk('message', 'user', 'lavora'),            // apre il turno
      mk('thinking', 'assistant', 'penso'),
      mk('tool-call', 'assistant', 'run-command', { id: 'a', name: 'run-command', arguments: '{}' }),
      mk('tool-result', 'system', 'out', { callId: 'a' }),
      mk('thinking', 'assistant', 'ancora penso'),
      mk('send-message', 'assistant', 'avanzamento', { message: { type: 'text', text: 'avanzamento' } }),
      mk('tool-call', 'assistant', 'run-command', { id: 'b', name: 'run-command', arguments: '{}' }),
      mk('tool-result', 'system', 'out2', { callId: 'b' }),
      mk('send-message', 'assistant', 'risultato finale', { message: { type: 'text', text: 'risultato finale' } })
    ]
    // da una sequenza di tool call e thinking, l'utente vede SOLO le send-message
    const visible = visibleReplyEntries(entries, entries[0]!.id)
    expect(visible.map((e) => e.content)).toEqual(['avanzamento', 'risultato finale'])
    // senza send-message (turno di routine silenzioso) → nessun messaggio visibile
    expect(visibleReplyEntries(entries.slice(0, 5), entries[0]!.id)).toHaveLength(0)
  })
})
