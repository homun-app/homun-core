// GC6.1 (fase guida-correzioni): quando il modello principale o i provider
// cambiano, il daemon EMETTE l'evento 'models' — lo store del renderer se ne
// accorge e si ricarica (prima leggeva provider e models.main solo
// all'avvio: la guida li scriveva e la finestra restava su «Nessun modello»
// finché non la ricaricavi). Le strade: la guida (Continua del passo model),
// le Impostazioni, il modello integrato pronto.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../main/agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

// il modulo dei provider è MOCKED: qui si prova l'EVENTO, non il salvataggio
vi.mock('../../main/agent/providers', () => ({
  saveProvider: async () => undefined,
  deleteProvider: () => undefined,
  publicProviders: () => [],
  getProvider: () => null,
  modelSupportsTools: async () => ({ ok: false, checked: false }),
  discoverProviders: async () => []
}))

const { setDataDir, dataDir, db } = await import('../../main/store/db')
const { buildApiMethods } = await import('../api')
import { TEST_TMP_BASE } from '../../test-tmp'
import type { SandbotEvent, MainModel } from '../../shared/types'

const MAIN: MainModel = { providerId: 'ollama', model: 'glm-5.3-flash:cloud', thinking: null }

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as never)

beforeAll(() => {
  // CB1 (fase ci-beta5): mkdtemp da TEST_TMP_BASE — il percorso letterale del
  // Mac di sviluppo non esiste sulla CI e il file non partiva (ENOENT)
  const dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-models-event-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

const modelsEvents = (): SandbotEvent[] => events.filter((e) => e.type === 'models')

describe('GC6.1: il daemon avvisa quando models.main o i provider cambiano', () => {
  it('settings:set models.main → evento models (la strada della guida e delle Impostazioni)', () => {
    events = []
    api['settings:set']!(['models.main', MAIN])
    expect(modelsEvents()).toEqual([{ type: 'models' }])
  })

  it('settings:set models.main a null (modello tolto) → evento models anche così', () => {
    events = []
    api['settings:set']!(['models.main', null])
    expect(modelsEvents()).toEqual([{ type: 'models' }])
  })

  it('le ALTRE impostazioni non emettono models', () => {
    events = []
    api['settings:set']!(['approvals.mode', 'ask'])
    expect(modelsEvents()).toEqual([])
  })

  it('providers:save e providers:delete → evento models', async () => {
    events = []
    await api['providers:save']!([{ id: 'p1', name: 'P', kind: 'ollama', baseUrl: '', enabled: true }])
    expect(modelsEvents()).toEqual([{ type: 'models' }])
    events = []
    api['providers:delete']!(['p1'])
    expect(modelsEvents()).toEqual([{ type: 'models' }])
  })
})
