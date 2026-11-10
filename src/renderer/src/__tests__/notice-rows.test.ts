// RV4 (fase beta.2), punto 3 — la notice RIPETUTA si mostra una volta:
// raggruppamento nel renderer della stessa notice consecutiva senza altro in
// mezzo (con un contatore discreto). Funzione PURA sulle entry del
// transcript: l'identità è il meta.ui (id + valori) — due notice scritte in
// due lingue diverse restano LA STESSA notice — e per le entry vecchie senza
// meta.ui vale il content.
import { describe, expect, it } from 'vitest'
import { groupRepeatedNotices } from '../lib/notice-rows'
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
