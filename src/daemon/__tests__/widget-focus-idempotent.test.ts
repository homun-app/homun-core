// OAC3 (fase guida, G1): la risposta al focus è idempotente NEL DAEMON, alla
// RPC — non più solo nella UI (confirming). Un widget:respond su una card del
// focus già risolta o chiusa risponde { ok: false } senza effetti e senza
// job; il testo libero sulla card APERTA crea il job E sveglia il worker
// (worker.poke, come gli altri widget). Store reale su mkdtemp del percorso
// esplicito /var/folders/… (mai $TMPDIR né os.tmpdir()).
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

const { setDataDir, dataDir, db, createAgent, getEntries, appendEntry, updateEntryMeta, setSetting, getSetting } = await import('../../main/store/db')
const { listJobs } = await import('../../main/store/jobs')
const { buildApiMethods } = await import('../api')
const { createOnboarding } = await import('../onboarding')
import { TEST_TMP_BASE } from '../../test-tmp'
import type { Agent, OnboardingState, ProviderConfig, SendMessagePayload, SandbotEvent } from '../../shared/types'

setSetting('ui.activeLanguage', 'it')

const events: SandbotEvent[] = []
const emit: (e: SandbotEvent) => void = (e) => events.push(e)

let pokes = 0
let api: Record<string, (p: unknown[]) => unknown>

let dir: string
let agentId: string

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-focus-idem-'))
  setDataDir(dir)
  dataDir()
  db()
  // l'onboarding VERO del daemon, coi deps del runtime ridotti allo store reale
  const onboarding = createOnboarding({
    now: () => Date.now(),
    getSetting: (key, fallback) => getSetting(key, fallback),
    setSetting: (key, value) => setSetting(key, value),
    listAgents: (): Agent[] => [],
    createAgent: (name, description) => createAgent(name, description),
    getAgent: (id) => null,
    getEntries: (id) => getEntries(id),
    tx: <T,>(fn: () => T): T => fn(),
    updateAgent: () => undefined,
    listProviders: (): ProviderConfig[] => [],
    appendSystemSend: (aid, message, meta) => {
      const content = message.type === 'text' ? message.text : message.type === 'widget' ? message.prompt : ''
      appendEntry({ agentId: aid, kind: 'send-message', role: 'assistant', content, meta: { message, ...(meta ?? {}) } })
    },
    markWidgetResponded: (aid, entryId, value) => {
      const entry = getEntries(aid).find((e) => e.id === entryId)
      if (entry) updateEntryMeta(entryId, { ...(entry.meta ?? {}), respondedValue: value })
    },
    markWidgetDismissed: (aid, entryId) => {
      const entry = getEntries(aid).find((e) => e.id === entryId)
      if (entry) updateEntryMeta(entryId, { ...(entry.meta ?? {}), widgetDismissed: true })
    },
    connectedAppIds: async () => new Set<string>(),
    emit: (e) => emit(e)
  })
  api = buildApiMethods(emit, { poke: () => { pokes++ } } as never, undefined, undefined, { onboarding })
  agentId = createAgent('Bot', 'descrizione').id
  setSetting('mainAgentId', agentId)
  setSetting('onboarding.state', { step: 'chat', done: ['welcome', 'model', 'approvals'], skipped: [], startedAt: Date.now() } satisfies OnboardingState)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** una card del focus APERTA (come la inserisce il daemon all'ingresso in chat) */
const openFocusCard = (): number => {
  const card = appendEntry({
    agentId, kind: 'send-message', role: 'assistant', content: 'Su cosa vuoi che ti aiuti per primo?',
    meta: {
      onboardingFocus: true,
      message: {
        type: 'widget', prompt: 'Su cosa vuoi che ti aiuti per primo?',
        options: [{ label: 'Posta e calendario', value: 'posta' }, { label: 'Lavoro di tutti i giorni', value: 'lavoro' }]
      } as SendMessagePayload
    }
  })
  return card.id
}

const sendCount = (): number => getEntries(agentId).filter((e) => e.kind === 'send-message').length
const jobCount = (): number => listJobs(db() as DatabaseSync).length

beforeEach(() => {
  db().exec('DELETE FROM jobs')
  pokes = 0
  events.length = 0
})

describe('OAC3 widget:respond sul focus: idempotente nel daemon', () => {
  it('doppia scelta: la seconda risponde { ok: false }, NESSUN nuovo effetto e nessun job', async () => {
    const entryId = openFocusCard()
    const first = await api['widget:respond']!([agentId, entryId, 'posta'])
    expect(first).toEqual({ ok: true })
    const sendsAfterFirst = sendCount()
    const second = await api['widget:respond']!([agentId, entryId, 'posta'])
    expect(second).toEqual({ ok: false })
    expect(sendCount()).toBe(sendsAfterFirst) // niente frasi doppie, niente card app doppie
    expect(jobCount()).toBe(0)
  })

  it('testo libero sulla card APERTA: job creato E worker svegliato (poke)', async () => {
    const entryId = openFocusCard()
    const r = await api['widget:respond']!([agentId, entryId, 'vorrei partire dalla posta'])
    expect(r).toEqual({ ok: true })
    expect(jobCount()).toBe(1)
    expect(pokes).toBe(1)
  })

  it('testo libero DOPO una scelta: { ok: false }, nessun job, nessun poke', async () => {
    const entryId = openFocusCard()
    await api['widget:respond']!([agentId, entryId, 'posta'])
    const jobsAfterChoice = jobCount()
    const r = await api['widget:respond']!([agentId, entryId, 'un testo in ritardo'])
    expect(r).toEqual({ ok: false })
    expect(jobCount()).toBe(jobsAfterChoice)
    expect(pokes).toBe(0)
  })

  it('chiusa senza scelta (dismiss), la scelta dopo → { ok: false } e nessun job', async () => {
    const entryId = openFocusCard()
    await api['onboarding:focus-dismiss']!([entryId])
    const r = await api['widget:respond']!([agentId, entryId, 'posta'])
    expect(r).toEqual({ ok: false })
    expect(jobCount()).toBe(0)
  })
})
