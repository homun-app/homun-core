// Fase 16c: le funzioni PURE del renderer — la prova «vale solo l'ultima»
// (model-probe), il modello della finestra Collega app (apps-view, ridotta
// dalla fase catalogo app ai soli server/plugin), le righe dell'Attività
// (activity-rows) e i filtri della Libreria (library-view). Il modello
// dell'elenco unico delle app sta in catalogo-app-view.test.ts.
import { describe, expect, it } from 'vitest'
import { nextModelProbe, EMPTY_MODEL_PROBE } from '../model-probe'
import { appsViewModel, botsLabelOf, serverRowStatus } from '../apps-view'
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

// ---- C4: appsViewModel (server e plugin di «Collegate») ----

describe('appsViewModel (C4, ridotta): le collegate uniscono server e plugin', () => {
  const agents = [
    { id: 'a1', name: 'Nina' }, { id: 'a2', name: 'Contabile' }, { id: 'a3', name: 'Ricercatore' }, { id: 'a4', name: 'Sesto' }
  ]

  it('le collegate uniscono server e plugin, coi nomi dei bot (max 2 + +N) e «Tutti i bot»', () => {
    const vm = appsViewModel({
      connectors: [],
      installed: {
        servers: [{ id: 'srv1', name: 'Registro X', enabledFor: ['a1', 'a2', 'a3', 'a4'] }, { id: 'srv2', name: 'Manuale', enabledFor: ['*'] }],
        plugins: [{ name: 'plug', marketplace: 'official', skills: [], servers: [] }]
      },
      agents, filter: 'all', query: '', lang: 'it'
    })
    expect(vm.connected).toHaveLength(3)
    const srv1 = vm.connected.find((r) => r.id === 'srv1')!
    expect(srv1.botsLabel).toEqual({ all: false, names: ['Nina', 'Contabile'], extra: 2 })
    expect(srv1.source).toBe('server')
    const srv2 = vm.connected.find((r) => r.id === 'srv2')!
    expect(srv2.botsLabel.all).toBe(true)
    expect(vm.connected.find((r) => r.id === 'plug')?.source).toBe('plugin')
  })

  it('la ricerca filtra le collegate per nome; botsLabelOf non inventa nomi', () => {
    const vm = appsViewModel({
      connectors: [],
      installed: { servers: [{ id: 'srv1', name: 'Registro X' }], plugins: [] },
      agents, filter: 'all', query: 'registro', lang: 'it'
    })
    expect(vm.connected.map((r) => r.id)).toEqual(['srv1'])
    expect(botsLabelOf(['a1', 'ghost'], agents)).toEqual({ all: false, names: ['Nina', 'ghost'], extra: 0 })
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

// ---- fase mcp-setup (M6.1): lo stato VERO della riga di un server ----

describe('serverRowStatus (M6.1)', () => {
  const base = { id: 'x', name: 'X' }
  it('needsAuth → setup («Da completare»), mai «Connessa» a un server mai partito', () => {
    expect(serverRowStatus({ ...base, needsAuth: { kind: 'setup', keys: ['mattermost_host'] } })).toBe('setup')
    expect(serverRowStatus({ ...base, needsAuth: { kind: 'env', keys: ['K'] } })).toBe('setup')
  })
  it('needsReauth o errore dell\'ultima prova → reconnect', () => {
    expect(serverRowStatus({ ...base, needsReauth: true })).toBe('reconnect')
    expect(serverRowStatus({ ...base }, 'needs_auth')).toBe('reconnect')
    expect(serverRowStatus({ ...base }, 'error')).toBe('reconnect')
  })
  it('senza needsAuth e senza errore → connected (verde solo se davvero partito)', () => {
    expect(serverRowStatus({ ...base })).toBe('connected')
    expect(serverRowStatus({ ...base }, 'connected')).toBe('connected')
  })
})
