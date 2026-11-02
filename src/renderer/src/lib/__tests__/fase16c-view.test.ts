// Fase 16c: le funzioni PURE del renderer — la prova «vale solo l'ultima»
// (model-probe), il modello della finestra Collega app (apps-view), le righe
// dell'Attività (activity-rows) e i filtri della Libreria (library-view).
import { describe, expect, it } from 'vitest'
import { nextModelProbe, EMPTY_MODEL_PROBE } from '../model-probe'
import { appsViewModel, botsLabelOf, FEATURED_ORDER } from '../apps-view'
import { activityRows } from '../activity-rows'
import { libraryRows } from '../library-view'
import type { ConnectorInfo, GlobalActivityData } from '../../../../shared/types'

// ---- C3.4: vale solo l'ultima prova ----

describe('nextModelProbe (C3.4): vale solo l\'ultima prova', () => {
  it('la risposta di una revisione VECCHIA si scarta (una più recente è partita)', () => {
    let s = nextModelProbe(EMPTY_MODEL_PROBE, { type: 'start', revision: 1 }, 1)
    expect(s.probing).toBe(true)
    s = nextModelProbe(s, { type: 'start', revision: 2 }, 2)
    // arriva la risposta della prova 1: si scarta, resta probing
    s = nextModelProbe(s, { type: 'result', revision: 1, ok: true, models: ['a'] }, 2)
    expect(s.probing).toBe(true)
    expect(s.ok).toBeNull()
    // arriva la risposta della prova 2: si applica
    s = nextModelProbe(s, { type: 'result', revision: 2, ok: true, models: ['a', 'b'] }, 2)
    expect(s).toEqual({ probing: false, ok: true, models: ['a', 'b'], error: null })
  })

  it('reset torna allo stato iniziale; l\'errore porta il CODICE, mai testo grezzo', () => {
    let s = nextModelProbe(EMPTY_MODEL_PROBE, { type: 'start', revision: 7 }, 7)
    s = nextModelProbe(s, { type: 'result', revision: 7, ok: false, error: 'invalid-key' }, 7)
    expect(s.ok).toBe(false)
    expect(s.error).toBe('invalid-key')
    expect(nextModelProbe(s, { type: 'reset' }, 7)).toEqual(EMPTY_MODEL_PROBE)
  })
})

// ---- C4: appsViewModel ----

const cat = (id: string, name: string, category: ConnectorInfo['category']): ConnectorInfo => ({
  id, name, logo: '·', mcpUrl: 'https://example.com', clientRegistration: 'dynamic', docsUrl: 'https://docs.example.com',
  notes: 'n', category, tagline: { it: `tagline ${id}`, en: `tagline en ${id}` },
  state: { status: 'not_connected', disabledTools: [], instructions: '' }, tools: []
})

const connected = (id: string): ConnectorInfo => ({
  ...cat(id, id, 'documents'), state: { status: 'connected', disabledTools: [], instructions: '' }
})

describe('appsViewModel (C4)', () => {
  const catalog = [cat('linear', 'Linear', 'development'), cat('gmail', 'Gmail', 'mail-calendar'),
    cat('notion', 'Notion', 'documents'), cat('gcalendar', 'Google Calendar', 'mail-calendar'),
    cat('gdrive', 'Google Drive', 'documents'), cat('stripe', 'Stripe', 'development')]
  const agents = [
    { id: 'a1', name: 'Nina' }, { id: 'a2', name: 'Contabile' }, { id: 'a3', name: 'Ricercatore' }, { id: 'a4', name: 'Sesto' }
  ]

  it('le consigliate: al massimo 4 NON collegate nell\'ordine fisso gmail, gcalendar, gdrive, notion, linear', () => {
    const vm = appsViewModel({ catalog, connectors: [], installed: null, agents, filter: 'all', query: '', lang: 'it' })
    expect(vm.featured.map((f) => f.id)).toEqual(['gmail', 'gcalendar', 'gdrive', 'notion'])
    expect(vm.featured[0]!.tagline).toBe('tagline gmail')
  })

  it('una consigliata già collegata si salta (linear subentra se c\'è posto)', () => {
    const vm = appsViewModel({ catalog, connectors: [connected('gmail')], installed: null, agents, filter: 'all', query: '', lang: 'it' })
    expect(vm.featured.map((f) => f.id)).toEqual(['gcalendar', 'gdrive', 'notion', 'linear'])
  })

  it('le collegate uniscono connettori, server e plugin, coi nomi dei bot (max 2 + +N) e «Tutti i bot»', () => {
    const vm = appsViewModel({
      catalog, connectors: [connected('gmail')],
      installed: {
        servers: [{ id: 'srv1', name: 'Registro X', enabledFor: ['a1', 'a2', 'a3', 'a4'] }, { id: 'srv2', name: 'Manuale', enabledFor: ['*'] }],
        plugins: [{ name: 'plug', marketplace: 'official', skills: [], servers: [] }]
      },
      agents, filter: 'all', query: '', lang: 'it'
    })
    expect(vm.connectedCount).toBe(4)
    const srv1 = vm.connected.find((r) => r.id === 'srv1')!
    expect(srv1.botsLabel).toEqual({ all: false, names: ['Nina', 'Contabile'], extra: 2 })
    const srv2 = vm.connected.find((r) => r.id === 'srv2')!
    expect(srv2.botsLabel.all).toBe(true)
  })

  it('il filtro per categoria lascia solo le voci di quella categoria (non collegate)', () => {
    const vm = appsViewModel({ catalog, connectors: [], installed: null, agents, filter: 'documents', query: '', lang: 'it' })
    expect(vm.catalogRows.map((c) => c.id).sort()).toEqual(['gdrive', 'notion'])
  })

  it('la ricerca filtra il catalogo per nome, id e tagline (in entrambe le lingue)', () => {
    const it = appsViewModel({ catalog, connectors: [], installed: null, agents, filter: 'all', query: 'tagline en notion', lang: 'en' })
    expect(it.catalogRows.map((c) => c.id)).toEqual(['notion'])
    const byName = appsViewModel({ catalog, connectors: [], installed: null, agents, filter: 'all', query: 'stripe', lang: 'it' })
    expect(byName.catalogRows.map((c) => c.id)).toEqual(['stripe'])
  })

  it('botsLabelOf: id che non sono bot restano com\'erano (mai silenziosi)', () => {
    expect(botsLabelOf(['a1', 'ghost'], agents)).toEqual({ all: false, names: ['Nina', 'ghost'], extra: 0 })
  })

  it('la categoria Comunicazione compare solo se il catalogo ne ha una voce', () => {
    expect(appsViewModel({ catalog, connectors: [], installed: null, agents, filter: 'all', query: '', lang: 'it' }).hasCommunication).toBe(false)
    const withComm = appsViewModel({
      catalog: [...catalog, cat('slack', 'Slack', 'communication')], connectors: [], installed: null, agents, filter: 'all', query: '', lang: 'it'
    })
    expect(withComm.hasCommunication).toBe(true)
  })

  it('FEATURED_ORDER non contiene voci inventate fuori dal catalogo di oggi', () => {
    expect(FEATURED_ORDER).toEqual(['gmail', 'gcalendar', 'gdrive', 'notion', 'linear'])
  })
})

// ---- C5: activityRows ----

describe('activityRows (C5)', () => {
  const data: GlobalActivityData = {
    tasks: [
      { id: 1, agentId: 'a1', title: 'Fatture ottobre', status: 'working', automatic: 0, createdAt: 100, updatedAt: 300, summary: null },
      { id: 2, agentId: 'a2', title: 'Pulizia report', status: 'needs_input', automatic: 0, createdAt: 100, updatedAt: 200, summary: null },
      { id: 3, agentId: 'a3', title: 'Rassegna stampa', status: 'done', automatic: 1, createdAt: 50, updatedAt: 150, summary: '3 link verificati e riassunti in una pagina' },
      { id: 4, agentId: 'a3', title: 'Avviso Bitcoin', status: 'failed', automatic: 1, createdAt: 40, updatedAt: 140, summary: null }
    ],
    runs: [
      { id: 10, routineId: 1, agentId: 'a2', title: 'Rassegna del mattino', startedAt: 500, endedAt: 600, outcome: 'ok', reason: null },
      { id: 11, routineId: 2, agentId: 'a2', title: 'Backup settimanale', startedAt: 700, endedAt: null, outcome: 'ok', reason: null },
      { id: 12, routineId: 3, agentId: 'a4', title: 'Avviso prezzo', startedAt: 800, endedAt: 850, outcome: 'failed', reason: 'credit' }
    ],
    waiting: ['a2']
  }

  it('l\'ordine: le attese in cima, poi chi lavora, poi il resto per data', () => {
    const rows = activityRows(data, 'all', '')
    // le attese: prima l\'attesa VIVA (adesso), poi il task needs_input
    expect(rows[0]!.kind).toBe('waiting')
    expect(rows[0]!.agentId).toBe('a2')
    expect(rows[1]!.key).toBe('task:2')
    // in corso: il run 11 (partito a 700) e il task 1 (toccati a 300)
    expect(rows[2]!.key).toBe('run:11')
    expect(rows[3]!.key).toBe('task:1')
    // poi per data desc: run:12 (850), run:10 (600), task:3 (150), task:4 (140)
    expect(rows.slice(4).map((r) => r.key)).toEqual(['run:12', 'run:10', 'task:3', 'task:4'])
  })

  it('«Da te» = task con automatic = 0 (anche needs_input, mai le routine)', () => {
    const rows = activityRows(data, 'mine', '')
    expect(rows.map((r) => r.key).sort()).toEqual(['task:1', 'task:2'])
  })

  it('«Routine» = le esecuzioni delle routine E i task automatici', () => {
    const rows = activityRows(data, 'routines', '')
    expect(rows.map((r) => r.key).sort()).toEqual(['run:10', 'run:11', 'run:12', 'task:3', 'task:4'])
  })

  it('«Non riusciti» = task e routine fallite, col motivo in CODICE', () => {
    const rows = activityRows(data, 'failed', '')
    expect(rows.map((r) => r.key).sort()).toEqual(['run:12', 'task:4'])
    expect(rows.find((r) => r.key === 'run:12')!.reason).toBe('credit')
    expect(rows.find((r) => r.key === 'task:4')!.status).toBe('failed')
  })

  it('la ricerca cerca nel titolo e nel summary', () => {
    expect(activityRows(data, 'all', 'bitcoin').map((r) => r.key)).toEqual(['task:4'])
    expect(activityRows(data, 'all', 'link verificati').map((r) => r.key)).toEqual(['task:3'])
    expect(activityRows(data, 'all', 'rassegn').map((r) => r.key)).toEqual(['run:10', 'task:3'])
  })
})

// ---- C6: libraryRows ----

describe('libraryRows (C6): filtri e ordine (fissati in cima, poi updatedAt)', () => {
    const items = [
    { id: 'a', kind: 'document' as const, title: 'Doc vecchio', authorAgentId: 'a1', createdAt: 1, updatedAt: 10, pinned: false, tainted: false, currentVersion: 1, chartKind: null, fileName: null, fileSize: null, fileMime: null },
    { id: 'b', kind: 'chart' as const, title: 'Grafico fisso', authorAgentId: 'a2', createdAt: 1, updatedAt: 20, pinned: true, tainted: false, currentVersion: 1, chartKind: 'vega-lite' as const, fileName: null, fileSize: null, fileMime: null },
    { id: 'c', kind: 'file' as const, title: 'File nuovo', authorAgentId: 'a1', createdAt: 1, updatedAt: 30, pinned: false, tainted: true, currentVersion: 1, chartKind: null, fileName: 'f.xlsx', fileSize: 12, fileMime: null }
  ]
  it('fissati in cima, poi per updatedAt desc', () => {
    expect(libraryRows(items, '', '').map((i) => i.id)).toEqual(['b', 'c', 'a'])
  })
  it('filtro per bot (authorAgentId, client-side) e per tipo', () => {
    expect(libraryRows(items, 'a1', '').map((i) => i.id)).toEqual(['c', 'a'])
    expect(libraryRows(items, '', 'document').map((i) => i.id)).toEqual(['a'])
  })
})

// ---- fase 16c correzioni (R8.1): «Altre app» senza doppioni ----

describe('R8.1 — appsViewModel: la lista sotto le consigliate non ripete nulla', () => {
  // stesse fixture del describe C4 qui sopra
  const catalog = [cat('linear', 'Linear', 'development'), cat('gmail', 'Gmail', 'mail-calendar'),
    cat('notion', 'Notion', 'documents'), cat('gcalendar', 'Google Calendar', 'mail-calendar'),
    cat('gdrive', 'Google Drive', 'documents'), cat('stripe', 'Stripe', 'development')]
  const agents = [
    { id: 'a1', name: 'Nina' }, { id: 'a2', name: 'Contabile' }, { id: 'a3', name: 'Ricercatore' }, { id: 'a4', name: 'Sesto' }
  ]

  it('pillola Tutte, ricerca vuota: la lista ESCLUDE le consigliate (diventa «Altre app»)', () => {
    const vm = appsViewModel({ catalog, connectors: [], installed: null, agents, filter: 'all', query: '', lang: 'it' })
    expect(vm.featured.map((f) => f.id)).toEqual(['gmail', 'gcalendar', 'gdrive', 'notion'])
    // la lista sotto NON contiene le consigliate: restano solo le altre
    expect(vm.catalogRows.map((c) => c.id)).toEqual(['linear', 'stripe'])
  })

  it('con una CATEGORIA scelta si vede TUTTO ciò che corrisponde (consigliate comprese), senza doppioni', () => {
    const vm = appsViewModel({ catalog, connectors: [], installed: null, agents, filter: 'documents', query: '', lang: 'it' })
    expect(vm.catalogRows.map((c) => c.id).sort()).toEqual(['gdrive', 'notion'])
    // la sezione consigliate non c'è (lo sa la finestra: pillola Tutte)
    expect(vm.featured.length).toBe(4) // il modello le calcola comunque
  })

  it('con una RICERCA si vede TUTTO ciò che corrisponde, anche le consigliate', () => {
    const vm = appsViewModel({ catalog, connectors: [], installed: null, agents, filter: 'all', query: 'notion', lang: 'it' })
    expect(vm.catalogRows.map((c) => c.id)).toEqual(['notion'])
  })

  it('nessuna voce compare MAI due volte fra consigliate e lista (Tutte + ricerca vuota)', () => {
    const vm = appsViewModel({ catalog, connectors: [], installed: null, agents, filter: 'all', query: '', lang: 'it' })
    const ids = [...vm.featured.map((f) => f.id), ...vm.catalogRows.map((c) => c.id)]
    expect(new Set(ids).size).toBe(ids.length)
    // e tutte le voci del catalogo non collegate sono sullo schermo una volta
    expect(ids.sort()).toEqual(['gcalendar', 'gdrive', 'gmail', 'linear', 'notion', 'stripe'])
  })
})
