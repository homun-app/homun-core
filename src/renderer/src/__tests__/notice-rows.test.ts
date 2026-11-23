// RV4 (fase beta.2), punto 3 — la notice RIPETUTA si mostra una volta:
// raggruppamento nel renderer della stessa notice consecutiva senza altro in
// mezzo (con un contatore discreto). Funzione PURA sulle entry del
// transcript: l'identità è il meta.ui (id + valori) — due notice scritte in
// due lingue diverse restano LA STESSA notice — e per le entry vecchie senza
// meta.ui vale il content.
import { describe, expect, it } from 'vitest'
import { groupRepeatedNotices } from '../lib/notice-rows'
import { chatRowHidden } from '../lib/chat-rows'
import type { TranscriptEntry } from '../../../shared/types'

const e = (id: number, over: Partial<TranscriptEntry>): TranscriptEntry => ({
  id,
  agentId: 'bot-1',
  kind: 'notice',
  role: 'system',
  content: 'Configura prima un provider e un modello.',
  meta: null,
  createdAt: id,
  ...over
})

const notice = (id: number, content = 'Configura prima un provider e un modello.') =>
  e(id, { content, meta: { ui: { id: 'notice.configureProviderFirst' } } })

describe('RV4: la stessa notice consecutiva si mostra UNA volta', () => {
  it('due identiche di fila → un gruppo solo, repeat 2', () => {
    const out = groupRepeatedNotices([notice(1), notice(2)])
    expect(out).toHaveLength(1)
    expect(out[0]!.repeat).toBe(2)
    expect(out[0]!.entry.id).toBe(1)
  })

  it('tre identiche di fila → repeat 3; poi una DIVERSA (altro id UI) → gruppo nuovo', () => {
    const other = e(4, { content: 'Coda piena: messaggio scartato.', meta: { ui: { id: 'notice.queueFull' } } })
    const out = groupRepeatedNotices([notice(1), notice(2), notice(3), other])
    expect(out).toHaveLength(2)
    expect(out[0]!.repeat).toBe(3)
    expect(out[1]!.repeat).toBe(1)
  })

  it('la stessa notice con VALORI diversi NON si raggruppa (posizione in coda diversa)', () => {
    const out = groupRepeatedNotices([
      e(1, { content: 'in coda (posizione 1)', meta: { ui: { id: 'notice.agentBusyQueued', values: { position: 1 } } } }),
      e(2, { content: 'in coda (posizione 2)', meta: { ui: { id: 'notice.agentBusyQueued', values: { position: 2 } } } })
    ])
    expect(out).toHaveLength(2)
  })

  it('qualcosa in mezzo spezza il raggruppamento (il messaggio utente conta)', () => {
    const out = groupRepeatedNotices([
      notice(1),
      e(2, { kind: 'message', role: 'user', content: 'ciao' }),
      notice(3)
    ])
    expect(out).toHaveLength(3)
    expect(out.map((g) => g.repeat)).toEqual([1, 1, 1])
  })

  it('la stessa notice scritta in due LINGUE diverse è LA STESSA (identità = meta.ui)', () => {
    const out = groupRepeatedNotices([
      e(1, { content: 'Configura prima un provider e un modello.', meta: { ui: { id: 'notice.configureProviderFirst' } } }),
      e(2, { content: 'Configure a provider and a model first.', meta: { ui: { id: 'notice.configureProviderFirst' } } })
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.repeat).toBe(2)
  })

  it('entry vecchie senza meta.ui: il content decide (uguale → gruppo, diverso → no)', () => {
    expect(groupRepeatedNotices([e(1, { meta: null }), e(2, { meta: null })])).toHaveLength(1)
    expect(groupRepeatedNotices([e(1, { meta: null }), e(2, { content: 'altro', meta: null })])).toHaveLength(2)
  })

  it('elenco vuoto → vuoto', () => {
    expect(groupRepeatedNotices([])).toEqual([])
  })
})

// ---- B2 (fase b20-bug): l'avviso che torna a ogni turno automatico ----
// Il caso visto dall'utente: in chat quattro coppie di fila «Avvio automatico»
// + «risposta vuota». Gli avvisi NON sono adiacenti (in mezzo c'è l'apertura
// di ogni turno): qui si raccolgono lo stesso — una riga sola col conteggio,
// con UNA riga di apertura davanti.
describe('B2: lo stesso avviso dopo ogni apertura automatica si raccoglie in una riga sola', () => {
  const empty = (id: number, why: string = 'reasoning') =>
    e(id, { content: 'Risposta vuota.', meta: { ui: { id: 'notice.modelEmpty', values: { why } } } })
  const wake = (id: number, initiator = 'SHELL_DONE') =>
    e(id, { kind: 'message', role: 'user', content: '<comando_finito>…', meta: { initiator } })

  it('quattro coppie di fila (apertura + avviso) → UNA apertura (lead) e UN avviso, repeat 4', () => {
    const out = groupRepeatedNotices([wake(1), empty(2), wake(3), empty(4), wake(5), empty(6), wake(7), empty(8)])
    expect(out).toHaveLength(1)
    expect(out[0]!.entry.id).toBe(2)
    expect(out[0]!.repeat).toBe(4)
    expect(out[0]!.lead?.id).toBe(1)
  })

  it('una coppia sola resta com’è: apertura e avviso, repeat 1, nessun lead', () => {
    const out = groupRepeatedNotices([wake(1), empty(2)])
    expect(out).toEqual([{ entry: expect.objectContaining({ id: 1 }), repeat: 1 }, { entry: expect.objectContaining({ id: 2 }), repeat: 1 }])
    expect(out[1]!.lead).toBeUndefined()
  })

  it('il motivo cambia (why diverso) → sono due avvisi diversi: nessun raggruppamento', () => {
    const out = groupRepeatedNotices([wake(1), empty(2, 'reasoning'), wake(3), empty(4, 'noOutput')])
    expect(out.map((g) => [g.entry.id, g.repeat])).toEqual([[1, 1], [2, 1], [3, 1], [4, 1]])
  })

  it('valgono TUTTE le aperture automatiche (routine, risvegli, [sistema], riprovo) — non il messaggio dell’utente', () => {
    const auto = groupRepeatedNotices([
      e(1, { kind: 'message', role: 'user', content: 'r', meta: { initiator: 'ROUTINE', routineTitle: 'Novità' } }),
      empty(2),
      e(3, { kind: 'message', role: 'user', content: 'r', meta: { initiator: 'CONNECTOR_INSTALLED' } }),
      empty(4),
      e(5, { kind: 'message', role: 'user', content: 'r', meta: { retryOf: 2 } }),
      empty(6)
    ])
    expect(auto).toHaveLength(1)
    expect(auto[0]!.repeat).toBe(3)
    expect(auto[0]!.lead?.id).toBe(1)
    // un messaggio dell'utente (senza initiator) in mezzo spezza: non è un'apertura automatica
    const human = groupRepeatedNotices([empty(1), e(2, { kind: 'message', role: 'user', content: 'e invece?', meta: null }), empty(3)])
    expect(human.map((g) => [g.entry.id, g.repeat])).toEqual([[1, 1], [2, 1], [3, 1]])
  })

  it('una risposta del bot in mezzo spezza (l’avviso dopo è un altro avviso)', () => {
    const reply = e(3, { kind: 'send-message', role: 'assistant', content: 'ecco', meta: { message: { type: 'text' } } })
    const out = groupRepeatedNotices([wake(1), empty(2), wake(4), reply, empty(5)])
    expect(out.map((g) => g.entry.id)).toEqual([1, 2, 4, 3, 5])
    expect(out.every((g) => g.repeat === 1)).toBe(true)
  })

  it('più aperture di fila fra un avviso e l’altro: una riga sola davanti, quella che precedeva il PRIMO avviso', () => {
    const out = groupRepeatedNotices([wake(1), empty(2), wake(3), wake(4), empty(5)])
    expect(out).toHaveLength(1)
    expect(out[0]!.entry.id).toBe(2)
    expect(out[0]).toMatchObject({ repeat: 2, lead: expect.objectContaining({ id: 1 }) })
  })

  it('davanti al primo avviso non c’è un’apertura automatica (una bolla dell’utente): l’avviso si raccoglie, senza lead', () => {
    const human = e(1, { kind: 'message', role: 'user', content: 'le novità?', meta: null })
    const out = groupRepeatedNotices([human, empty(2), wake(3), empty(4)])
    expect(out).toHaveLength(2)
    expect(out[1]!.repeat).toBe(2)
    expect(out[1]!.lead).toBeUndefined()
  })
})

// ---- B2: le entry INVISIBILI (ragionamento, fine turno) non spezzano il gruppo ----
// Nel transcript vero ogni turno del loop scrive: apertura · thinking · avviso ·
// evento di fine turno. La vista raccogglie gli avvisi sulle righe che MOSTRA.
describe('B2: le entry che la chat non mostra non spezzano il raggruppamento', () => {
  const empty = (id: number) => e(id, { content: 'Risposta vuota.', meta: { ui: { id: 'notice.modelEmpty', values: { why: 'reasoning' } } } })
  const wake = (id: number) => e(id, { kind: 'message', role: 'user', content: '<comando_finito>…', meta: { initiator: 'SHELL_DONE' } })
  const think = (id: number) => e(id, { kind: 'thinking', role: 'assistant', content: 'penso' })
  const turnEnd = (id: number) => e(id, { kind: 'event', role: 'system', content: 'Turno interrotto', meta: { turnEnd: 'STOPPED', stopReason: 'model-error' } })
  const turn = (i: number) => [wake(i * 4 + 1), think(i * 4 + 2), empty(i * 4 + 3), turnEnd(i * 4 + 4)]
  const hiddenByDefault = [0, 1, 2, 3].flatMap(turn).filter((x) => !chatRowHidden(x, { showReasoning: false, debugSteps: false }))
  const shownWithReasoning = [0, 1].flatMap(turn).filter((x) => !chatRowHidden(x, { showReasoning: true, debugSteps: false }))

  it('chatRowHidden: di default non si mostrano thinking, summary, fine turno, tool-call e tool-result; un [sistema] sì', () => {
    const view = { showReasoning: false, debugSteps: false }
    expect(chatRowHidden(think(1), view)).toBe(true)
    expect(chatRowHidden(e(2, { kind: 'summary', role: 'assistant', content: 'riepilogo' }), view)).toBe(true)
    expect(chatRowHidden(turnEnd(3), view)).toBe(true)
    expect(chatRowHidden(e(4, { kind: 'tool-call', role: 'assistant', content: 'run-command' }), view)).toBe(true)
    expect(chatRowHidden(e(5, { kind: 'tool-result', role: 'system', content: 'ok' }), view)).toBe(true)
    expect(chatRowHidden(wake(6), view)).toBe(false)
    expect(chatRowHidden(empty(7), view)).toBe(false)
    expect(chatRowHidden(e(8, { kind: 'message', role: 'user', content: 'ciao', meta: null }), view)).toBe(false)
    // ciò che resta in attesa nell'outbox non si mostra
    expect(chatRowHidden(e(9, { kind: 'send-message', role: 'assistant', content: 'x', meta: { held: true } }), view)).toBe(true)
  })

  it('con «Mostra il ragionamento» il ragionamento SI VEDE: allora spezza il gruppo', () => {
    expect(chatRowHidden(think(1), { showReasoning: true, debugSteps: false })).toBe(false)
    // otto righe, nessun gruppo: il ragionamento (2, 6) e i fine turno (4, 8) si vedono
    expect(groupRepeatedNotices(shownWithReasoning).map((g) => [g.entry.id, g.repeat])).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((id) => [id, 1]))
  })

  it('con i passaggi di debug le chiamate degli strumenti SI VEDONO: anche loro spezzano', () => {
    expect(chatRowHidden(e(1, { kind: 'tool-call', role: 'assistant', content: 'run-command' }), { showReasoning: false, debugSteps: true })).toBe(false)
  })

  it('quattro turni veri (apertura · thinking · avviso · fine turno) → sulle righe mostrate UNA apertura e UN avviso, repeat 4', () => {
    expect(hiddenByDefault.map((x) => x.id)).toEqual([1, 3, 5, 7, 9, 11, 13, 15])
    const out = groupRepeatedNotices(hiddenByDefault)
    expect(out).toHaveLength(1)
    expect(out[0]!.repeat).toBe(4)
    expect(out[0]!.lead?.id).toBe(1)
    expect(out[0]!.entry.id).toBe(3)
  })

  it('un evento che la chat MOSTRA (non di fine turno) spezza come una riga qualunque', () => {
    const shown = e(9, { kind: 'event', role: 'system', content: 'Qualcos\'altro', meta: null })
    expect(chatRowHidden(shown, { showReasoning: false, debugSteps: false })).toBe(false)
    const out = groupRepeatedNotices([wake(1), empty(2), shown, wake(4), empty(5)])
    expect(out.map((g) => [g.entry.id, g.repeat])).toEqual([[1, 1], [2, 1], [9, 1], [4, 1], [5, 1]])
  })
})
