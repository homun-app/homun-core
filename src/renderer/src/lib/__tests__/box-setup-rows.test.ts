// OB2 (fase onboarding-b): le righe dell'avanzamento della preparazione —
// la lista verticale che la guida e le Impostazioni condividono. La mappa
// fase → righe è PURA (boxSetupRows): ogni riga dice da fare / in corso /
// fatta ✓ / errore, e su awaiting-installer la riga dell'installazione
// diventa l'AZIONE («Apri l'installazione»).
import { describe, expect, it } from 'vitest'
import { boxSetupRows, BOX_SETUP_ROW_IDS, type BoxSetupRowState } from '../box-setup-rows'
import type { BoxSetupState } from '../../../../shared/types'

const state = (patch: Partial<BoxSetupState>): BoxSetupState => ({
  phase: 'idle', bytes: null, total: null, buildPhase: null, error: null, startedAt: null, skipped: [], phaseStartedAt: null, neededBytes: 3_400_000_000, ...patch
})

/** le righe in forma compatta: [id, stato] */
const rowsOf = (s: BoxSetupState): Array<[string, BoxSetupRowState]> => boxSetupRows(s).map((r) => [r.id, r.status])

describe('OB2 boxSetupRows (pura): la lista delle sei fasi', () => {
  it('le sei righe, nell\'ordine della guida', () => {
    expect(BOX_SETUP_ROW_IDS).toEqual(['download', 'verify', 'installer', 'service', 'kernel', 'image'])
    expect(boxSetupRows(state({})).map((r) => r.id)).toEqual(BOX_SETUP_ROW_IDS)
  })

  it('senza preparazione (idle) tutte da fare', () => {
    expect(rowsOf(state({ phase: 'idle' }))).toEqual([
      ['download', 'todo'], ['verify', 'todo'], ['installer', 'todo'], ['service', 'todo'], ['kernel', 'todo'], ['image', 'todo']
    ])
  })

  it('downloading: la prima in corso (con byte e totale), le altre da fare', () => {
    const r = boxSetupRows(state({ phase: 'downloading', bytes: 10, total: 100 }))
    expect(r[0]).toMatchObject({ id: 'download', status: 'running', bytes: 10, total: 100 })
    expect(r[1]!.status).toBe('todo')
  })

  it('verifying: download fatto, verifica in corso', () => {
    expect(rowsOf(state({ phase: 'verifying' }))).toEqual([
      ['download', 'done'], ['verify', 'running'], ['installer', 'todo'], ['service', 'todo'], ['kernel', 'todo'], ['image', 'todo']
    ])
  })

  it('awaiting-installer: la riga dell\'installazione è l\'AZIONE «Apri l\'installazione»', () => {
    const r = boxSetupRows(state({ phase: 'awaiting-installer' }))
    expect(r[2]).toMatchObject({ id: 'installer', status: 'action' })
    expect(r[0]!.status).toBe('done')
    expect(r[1]!.status).toBe('done')
  })

  it('le fasi dopo: servizio, kernel, immagine (con la fase del build)', () => {
    expect(rowsOf(state({ phase: 'starting-service' }))[3]).toEqual(['service', 'running'])
    expect(rowsOf(state({ phase: 'installing-kernel' }))[4]).toEqual(['kernel', 'running'])
    const img = boxSetupRows(state({ phase: 'building-image', buildPhase: { activity: 'running', step: 2, steps: 4, bytes: null, total: null } }))[5]!
    expect(img).toMatchObject({ id: 'image', status: 'running', buildPhase: { activity: 'running', step: 2, steps: 4 } })
  })

  it('ready: tutte fatte', () => {
    expect(rowsOf(state({ phase: 'ready' }))).toEqual([
      ['download', 'done'], ['verify', 'done'], ['installer', 'done'], ['service', 'done'], ['kernel', 'done'], ['image', 'done']
    ])
  })

  it('error: la riga della fase di colpa è in errore, le fatte restano fatte', () => {
    const sha = rowsOf(state({ phase: 'error', error: { phase: 'verifying', code: 'sha256', message: 'x' } }))
    expect(sha[0]).toEqual(['download', 'done'])
    expect(sha[1]).toEqual(['verify', 'error'])
    expect(sha[2]).toEqual(['installer', 'todo'])
    const svc = rowsOf(state({ phase: 'error', error: { phase: 'starting-service', code: 'service', message: 'x' } }))
    expect(svc[3]).toEqual(['service', 'error'])
    expect(svc[0]).toEqual(['download', 'done'])
  })

  it('cancelled: le fasi mai iniziate tornano da fare', () => {
    const r = rowsOf(state({ phase: 'cancelled' }))
    expect(r.every(([id, st]) => ['download', 'verify', 'installer'].includes(id) ? st === 'todo' : st === 'todo')).toBe(true)
  })

  it('checking-space: tutto da fare (il download non è ancora cominciato)', () => {
    expect(rowsOf(state({ phase: 'checking-space' }))[0]).toEqual(['download', 'todo'])
  })
})

// ---- OBD2: le righe saltate ----

describe('OBD2: le righe SALTATE (skipped) — segno neutro, mai il ✓ delle fasi fatte', () => {
  it('partenza da building-image → download…kernel sono skipped, NON done (oggi mentivano)', () => {
    const s = state({ phase: 'building-image', skipped: ['download', 'verify', 'installer', 'service', 'kernel'] })
    expect(rowsOf(s)).toEqual([
      ['download', 'skipped'], ['verify', 'skipped'], ['installer', 'skipped'],
      ['service', 'skipped'], ['kernel', 'skipped'], ['image', 'running']
    ])
  })

  it('a ready le righe saltate RESTANO saltate (le altre sono fatte ✓)', () => {
    const s = state({ phase: 'ready', skipped: ['download', 'verify', 'installer'] })
    expect(rowsOf(s)).toEqual([
      ['download', 'skipped'], ['verify', 'skipped'], ['installer', 'skipped'],
      ['service', 'done'], ['kernel', 'done'], ['image', 'done']
    ])
  })

  it('una riga saltata non è mai in corso: lo stato la dice com\'è arrivata', () => {
    // skipped viene da COM'È PARTITA la preparazione (o dal kernel trovato
    // presente): le righe prima della partenza, solo quelle
    const s = state({ phase: 'starting-service', skipped: ['download', 'verify', 'installer'] })
    expect(rowsOf(s)).toEqual([
      ['download', 'skipped'], ['verify', 'skipped'], ['installer', 'skipped'],
      ['service', 'running'], ['kernel', 'todo'], ['image', 'todo']
    ])
  })
})
