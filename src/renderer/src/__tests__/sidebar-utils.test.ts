// Test del filtro della ricerca della sidebar (fase 16, U4/U6): bot e gruppi
// per nome, maiuscole/minuscole irrilevanti, spazi = parole tutte necessarie.
// E dell'anteprima dell'ultimo messaggio visibile.
import { describe, expect, it } from 'vitest'
import { matchesQuery, filterSidebar, previewOf } from '../sidebar-utils'
import type { Agent, GroupInfo, TranscriptEntry } from '../../../shared/types'

const agent = (id: string, name: string, section: string | null = null): Agent => ({
  id, name, description: '', providerId: null, model: null, status: 'idle', unread: 0,
  createdAt: 1, createdBy: null, section, parentId: null, avatar: null
})

const group = (id: number, name: string): GroupInfo => ({
  id, name, description: '', createdBy: 'u', coordinatorId: null, members: [], createdAt: 1
})

const entry = (over: Partial<TranscriptEntry> & Pick<TranscriptEntry, 'id' | 'kind' | 'role'>): TranscriptEntry => ({
  agentId: 'a', content: '', meta: null, createdAt: 1, ...over
})

describe('fase 16 (U6): filtro della ricerca', () => {
  it('query vuota (o solo spazi) mostra tutto', () => {
    const agents = [agent('1', 'Nanna'), agent('2', 'Moto bot')]
    const groups = [group(1, 'Weekend')]
    expect(filterSidebar(agents, groups, '')).toEqual({ agents, groups })
    expect(filterSidebar(agents, groups, '   ')).toEqual({ agents, groups })
  })
  it('maiuscole/minuscole irrilevanti', () => {
    expect(matchesQuery('Nanna Bot', 'nanna')).toBe(true)
    expect(matchesQuery('Nanna Bot', 'NANNA')).toBe(true)
    expect(matchesQuery('Weekend a Roma', 'roma')).toBe(true)
  })
  it('gli spazi separano parole che devono esserci TUTTE', () => {
    expect(matchesQuery('Nanna Bot', 'nanna bot')).toBe(true)
    expect(matchesQuery('Nanna Bot', 'nanna   bot')).toBe(true)
    expect(matchesQuery('Nanna Bot', 'bot nanna')).toBe(true)
    expect(matchesQuery('Nanna Bot', 'nanna moto')).toBe(false)
  })
  it('filtra bot e gruppi per nome', () => {
    const agents = [agent('1', 'Nanna'), agent('2', 'Moto bot', 'Lavoro')]
    const groups = [group(1, 'Weekend'), group(2, 'Nanna e amici')]
    const r = filterSidebar(agents, groups, 'nanna')
    expect(r.agents.map((a) => a.id)).toEqual(['1'])
    expect(r.groups.map((g) => g.id)).toEqual([2])
    const r2 = filterSidebar(agents, groups, 'weekend')
    expect(r2.agents).toEqual([])
    expect(r2.groups.map((g) => g.id)).toEqual([1])
  })
})

describe('fase 16 (U4): anteprima dell’ultimo messaggio visibile', () => {
  it('l’ultimo send-message di testo vince', () => {
    const es = [
      entry({ id: 1, kind: 'message', role: 'user', content: 'ciao' }),
      entry({ id: 2, kind: 'send-message', role: 'assistant', content: 'Ecco fatto', meta: { message: { type: 'text', text: 'Ecco fatto' } } })
    ]
    expect(previewOf(es)).toBe('Ecco fatto')
  })
  it('i messaggi dell’utente hanno il prefisso Tu: ; quelli di altri bot/initiator si saltano', () => {
    const es = [
      entry({ id: 1, kind: 'message', role: 'user', content: 'da altro', meta: { initiator: 'AGENT', fromAgentName: 'X' } }),
      entry({ id: 2, kind: 'message', role: 'user', content: 'mio' })
    ]
    expect(previewOf(es)).toBe('Tu: mio')
  })
  it('i send-message trattenuti (outbox) e le card non fanno anteprima; il widget mostra la domanda', () => {
    const held = [entry({ id: 1, kind: 'send-message', role: 'assistant', content: 'in attesa', meta: { held: true, message: { type: 'text', text: 'in attesa' } } })]
    expect(previewOf(held)).toBe('')
    const widget = [entry({ id: 2, kind: 'send-message', role: 'assistant', content: '', meta: { message: { type: 'widget', prompt: 'Vuoi il riepilogo?' } } })]
    expect(previewOf(widget)).toBe('Vuoi il riepilogo?')
    const draft = [entry({ id: 3, kind: 'send-message', role: 'assistant', content: '', meta: { message: { type: 'draft', to: 'x@y.it' } } })]
    expect(previewOf(draft)).toBe('Bozza per x@y.it')
  })
})
