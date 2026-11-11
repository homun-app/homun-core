// Test del filtro della ricerca della sidebar (fase 16, U4/U6): bot e gruppi
// per nome, maiuscole/minuscole irrilevanti, spazi = parole tutte necessarie.
// E dell'anteprima dell'ultimo messaggio visibile.
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { matchesQuery, filterSidebar, previewOf, plainPreview, buildSidebarModel, collapsedVoices, teamOpenState, type SidebarPreview } from '../sidebar-utils'
import type { Agent, GroupInfo, TranscriptEntry } from '../../../shared/types'
import { itCatalogEntries } from './po-helper'

// fase 17a: le anteprime con prefisso sono descriptor — l'italiano si
// risolve dal catalogo it, come farà la sidebar
i18n.load('it', itCatalogEntries())
i18n.activate('it')
const resolve = (p: SidebarPreview): string => (typeof p === 'string' ? p : i18n.t(p))

const agent = (id: string, name: string, section: string | null = null): Agent => ({
  id, name, description: '', providerId: null, model: null, status: 'idle', unread: 0,
  createdAt: 1, createdBy: null, section, parentId: null, avatar: null
})

const group = (id: number, name: string, members: GroupInfo['members'] = [], coordinatorId: string | null = null, lastMessageAt: number | null = null): GroupInfo => ({
  id, name, description: '', createdBy: 'u', coordinatorId, members, createdAt: 1, lastMessageAt
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
    expect(resolve(previewOf(es))).toBe('Ecco fatto')
  })
  it('i messaggi dell’utente hanno il prefisso Tu: ; quelli di altri bot/initiator si saltano', () => {
    const es = [
      entry({ id: 1, kind: 'message', role: 'user', content: 'da altro', meta: { initiator: 'AGENT', fromAgentName: 'X' } }),
      entry({ id: 2, kind: 'message', role: 'user', content: 'mio' })
    ]
    expect(resolve(previewOf(es))).toBe('Tu: mio')
  })
  it('M2: OGNI initiator salta l’anteprima (routine, rientro, risvegli), non solo i tre di prima', () => {
    const es = [
      entry({ id: 1, kind: 'message', role: 'user', content: 'routine', meta: { initiator: 'ROUTINE', routineTitle: 'Backup' } }),
      entry({ id: 2, kind: 'message', role: 'user', content: 'rientro', meta: { initiator: 'LOOK_AROUND' } }),
      entry({ id: 3, kind: 'message', role: 'user', content: 'gruppo', meta: { initiator: 'GROUP_TURN' } }),
      entry({ id: 4, kind: 'message', role: 'user', content: 'shell', meta: { initiator: 'SHELL_DONE' } }),
      entry({ id: 5, kind: 'message', role: 'user', content: 'sottoagenti', meta: { initiator: 'SUBAGENTS_DONE' } }),
      entry({ id: 6, kind: 'message', role: 'user', content: 'mio' })
    ]
    expect(resolve(previewOf(es))).toBe('Tu: mio')
    const onlyAuto = es.slice(0, 5)
    expect(resolve(previewOf(onlyAuto))).toBe('')
  })
  it('i send-message trattenuti (outbox) e le card non fanno anteprima; il widget mostra la domanda', () => {
    const held = [entry({ id: 1, kind: 'send-message', role: 'assistant', content: 'in attesa', meta: { held: true, message: { type: 'text', text: 'in attesa' } } })]
    expect(resolve(previewOf(held))).toBe('')
    const widget = [entry({ id: 2, kind: 'send-message', role: 'assistant', content: '', meta: { message: { type: 'widget', prompt: 'Vuoi il riepilogo?' } } })]
    expect(resolve(previewOf(widget))).toBe('Vuoi il riepilogo?')
    const draft = [entry({ id: 3, kind: 'send-message', role: 'assistant', content: '', meta: { message: { type: 'draft', to: 'x@y.it' } } })]
    expect(resolve(previewOf(draft))).toBe('Bozza per x@y.it')
  })
})


// ---- fase 16b (S2): buildSidebarModel — chi ti risponde ----

const agent2 = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({
  ...agent(id, name), ...over
})

describe('fase 16b (S2): il modello della barra', () => {

  it('senza mainAgentId il principale è il primo bot', () => {
    const agents = [agent2('1', 'Nina'), agent2('2', 'Moto')]
    const m = buildSidebarModel(agents, [], null)
    expect(m.main?.id).toBe('1')
    // con mainAgentId impostato vince lui
    expect(buildSidebarModel(agents, [], '2').main?.id).toBe('2')
  })

  it('un bot in DUE squadre compare come membro sotto ciascuna (e non tra i bot singoli)', () => {
    const agents = [agent2('n', 'Nina'), agent2('s', 'Scout'), agent2('c', 'Contabile')]
    const groups = [
      group(1, 'Weekend', [
        { agentId: 'n', name: 'Nina', coordinator: true },
        { agentId: 's', name: 'Scout', coordinator: false }
      ], 'n'),
      group(2, 'Amministrazione', [
        { agentId: 'c', name: 'Contabile', coordinator: true },
        { agentId: 's', name: 'Scout', coordinator: false }
      ], 'c')
    ]
    const m = buildSidebarModel(agents, groups, 'n')
    expect(m.teams).toHaveLength(2)
    expect(m.teams[0]!.members.map((x) => x.id)).toEqual(['s'])
    expect(m.teams[1]!.members.map((x) => x.id)).toEqual(['s'])
    expect(m.bots.map((b) => b.agent.id)).toEqual([]) // Scout sta nelle squadre
  })

  it('i FIGLI (sottoagenti) non compaiono MAI: né come bot né come principale', () => {
    const agents = [agent2('1', 'Nina'), agent2('figlio', 'Figlio', { parentId: '1' })]
    const m = buildSidebarModel(agents, [], null)
    expect(m.main?.id).toBe('1')
    expect(m.bots).toEqual([])
  })

  it('le sezioni fanno da titoletto ai bot singoli', () => {
    const agents = [agent2('n', 'Nina'), agent2('r', 'Ricercatore', { section: 'Lavoro' }), agent2('m', 'Moto', { section: 'Lavoro' })]
    const m = buildSidebarModel(agents, [], 'n')
    expect(m.bots.map((b) => b.section)).toEqual(['Lavoro', 'Lavoro'])
    expect(m.bots.map((b) => b.agent.id)).toEqual(['r', 'm'])
  })

  it('la ricerca su un MEMBRE tiene la squadra (nome squadra, coordinatore o membro)', () => {
    const agents = [agent2('n', 'Nina'), agent2('s', 'Scout luoghi'), agent2('x', 'Solo')]
    const groups = [
      group(1, 'Weekend', [
        { agentId: 'n', name: 'Nina', coordinator: true },
        { agentId: 's', name: 'Scout luoghi', coordinator: false }
      ], 'n')
    ]
    const m = buildSidebarModel(agents, groups, 'n', 'scout')
    expect(m.teams.map((t) => t.group.id)).toEqual([1])
    expect(m.bots).toEqual([]) // Solo non combacia
    // il nome della squadra e del coordinatore valgono come filtro
    expect(buildSidebarModel(agents, groups, 'n', 'weekend').teams).toHaveLength(1)
    expect(buildSidebarModel(agents, groups, 'n', 'nina').teams).toHaveLength(1)
    expect(buildSidebarModel(agents, groups, 'n', 'amministrazione').teams).toHaveLength(0)
  })

  it('prima le squadre con qualcuno che ti aspetta, poi per attività recente', () => {
    const mk = (id: number, name: string, waiting: boolean, lastAt: number): GroupInfo =>
      group(id, name, [
        { agentId: 'n', name: 'Nina', coordinator: true },
        { agentId: 's', name: 'Scout', coordinator: false }
      ], 'n', lastAt)
    const agents = [
      agent2('n', 'Nina'),
      agent2('s1', 'Scout', { status: 'paused-for-approval' }),
      agent2('s', 'Scout2')
    ]
    // dati: vecchia con attesa, recente senza, vecchissima senza
    const groups = [
      mk(1, 'Vecchia', true, 100),
      mk(2, 'Recente', false, 300),
      mk(3, 'Antica', false, 50)
    ]
    // il membro in attesa è nelle squadre 1 e 3 (stessi member ids): costruiamo
    // squadre con membri distinti per un ordinamento pulito
    const g1 = group(1, 'Weekend', [
      { agentId: 'n', name: 'Nina', coordinator: true },
      { agentId: 'w', name: 'Aspetta', coordinator: false }
    ], 'n', 100)
    const g2 = group(2, 'Amministrazione', [
      { agentId: 'n', name: 'Nina', coordinator: true },
      { agentId: 'k', name: 'Contabile', coordinator: false }
    ], 'n', 300)
    void groups
    const all = [agent2('n', 'Nina'), agent2('w', 'Aspetta', { status: 'paused-for-approval' }), agent2('k', 'Contabile')]
    const m = buildSidebarModel(all, [g1, g2], 'n')
    expect(m.teams.map((t) => t.group.id)).toEqual([1, 2]) // l'attesa vince sull'attività
    expect(m.teams[0]!.waiting).toBe(true)
    expect(m.teams[0]!.waitingCount).toBe(1)
    expect(m.teams[1]!.waiting).toBe(false)
  })
})

describe('fase 16b (S2): la barra stretta (collapsedVoices)', () => {
  it('stesso ordine della barra larga: principale, squadre, bot — col contatore di chi aspetta', () => {
    const agents = [
      { ...agent('n', 'Nina') },
      agent2('w', 'Aspetta', { status: 'paused-for-approval' }),
      { ...agent('k', 'Contabile') },
      { ...agent('z', 'Zio') }
    ] as Agent[]
    const teams = [
      group(1, 'Weekend', [
        { agentId: 'n', name: 'Nina', coordinator: true },
        { agentId: 'w', name: 'Aspetta', coordinator: false }
      ], 'n', 10)
    ]
    const model = buildSidebarModel(agents, teams, 'n')
    const voices = collapsedVoices(model)
    expect(voices.map((v) => v.kind)).toEqual(['main', 'team', 'bot', 'bot'])
    expect(voices.map((v) => v.name)).toEqual(['Nina', 'Weekend', 'Contabile', 'Zio'])
    // la squadra con un membro in attesa porta il contatore, lo stato waiting
    expect(voices[1]!.counter).toBe(1)
    expect(voices[1]!.status).toBe('waiting')
    // un bot con non letti porta il contatore
    const withUnread = [{ ...agents[2]!, unread: 3 }] as Agent[]
    const m2 = buildSidebarModel([agents[0]!, withUnread[0]!], [], 'n')
    expect(collapsedVoices(m2)[1]!.counter).toBe(3)
  })
})

// fase 16b correzioni (P3): le squadre sono APERTE di default — in localStorage
// si ricorda solo la CHIUSURA scelta dall'utente
describe('fase 16b correzioni (P3): teamOpenState — una squadra senza stato salvato è aperta', () => {
  it('senza stato salvato (null) la squadra è APERTA', () => {
    expect(teamOpenState(null)).toBe(true)
  })
  it('si ricorda solo la chiusura: \'0\' è chiusa, ogni altro valore è aperta', () => {
    expect(teamOpenState('0')).toBe(false)
    expect(teamOpenState('1')).toBe(true)
  })
})

// ---- B3 (fase beta.4): l'anteprima è TESTO SEMPLICE ----

describe('B3: plainPreview — via il markdown dall\'anteprima della barra', () => {
  it('niente **, _, #, backtick: «Fatto! Ho creato il bot **"No…» diventa testo pulito', () => {
    expect(plainPreview('Fatto! Ho creato il bot **"Notizie Tech"** per te.')).toBe('Fatto! Ho creato il bot "Notizie Tech" per te.')
    expect(plainPreview('**grassetto** e _corsivo_ e *stellina*')).toBe('grassetto e corsivo e stellina')
    expect(plainPreview('## Titolo\nriga')).toBe('Titolo\nriga')
    expect(plainPreview('comando `npm test` fatto')).toBe('comando npm test fatto')
  })

  it('i link markdown diventano il loro testo', () => {
    expect(plainPreview('vedi [le note](https://esempio.it) qui')).toBe('vedi le note qui')
  })

  it('previewOf manda in barra SOLO testo semplice (bot e «Tu:»)', () => {
    const bot = previewOf([entry({ id: 1, kind: 'send-message', role: 'assistant', content: 'Fatto! Ho creato il bot **"Notizie Tech"**.', meta: { message: { type: 'text' } } })])
    expect(resolve(bot)).not.toContain('**')
    const tu = previewOf([entry({ id: 2, kind: 'message', role: 'user', content: 'bravo, _proprio_ bravo' })])
    expect(resolve(tu)).toBe('Tu: bravo, proprio bravo')
  })
})
