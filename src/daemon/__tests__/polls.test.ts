// Test dei trigger connector_poll (fase 6): tick con tool MCP FINTO — la
// prima esecuzione registra gli id esistenti senza scatenare eventi, poi un
// evento per ogni id NUOVO (solo quelli); preset calendar_event che programma
// il job a start - offsetMinutes; il trigger con tool non read-only viene
// RIFIUTATO alla creazione (validazione con toolsOfServer finto). Store reale
// su directory temporanea, orologio controllato dal test.
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// toolsOfServer finto (per la validazione readOnly in api.ts)
const h = vi.hoisted(() => ({
  tools: [] as Array<{ name: string; description: string; annotations?: { readOnlyHint?: boolean } }>,
  unreachable: [] as string[]
}))
vi.mock('../../main/mcp', () => ({
  toolsOfServer: async (id: string) => {
    if (h.unreachable.includes(id)) throw new Error('server non trovato')
    return h.tools
  },
  listServers: () => [],
  callTool: async () => ''
}))

const { setDataDir, dataDir, db, createRoutine, getSetting } = await import('../../main/store/db')
const { tickConnectorPolls } = await import('../scheduler')
const { listJobs } = await import('../../main/store/jobs')
const { buildApiMethods } = await import('../api')
import type { PollDeps } from '../scheduler'
import type { JobWorker } from '../worker'
import type { RoutineTrigger, SandbotEvent } from '../../shared/types'

const AGENT = 'agent_p'
let clock = 0
let mcpOutput = '[]'
const mcpCalls: Array<{ tool: string; args: Record<string, unknown> }> = []

const pollDeps = (): PollDeps => ({
  db: db(),
  emit: () => undefined,
  now: () => clock,
  callMcpTool: async (tool, args) => {
    mcpCalls.push({ tool, args })
    return mcpOutput
  }
})

const mkPollRoutine = (trigger: Partial<Extract<RoutineTrigger, { type: 'connector_poll' }>>): number => {
  const r = createRoutine(AGENT, 'Poll', 'guarda la posta', '0 0 1 1 *', {
    trigger: { type: 'connector_poll', connectorId: 'gmail', tool: 'mcp__gmail__search', intervalMin: 2, idField: 'messages[].id', ...trigger }
  })
  // il primo poll è dovuto un intervallo dopo la creazione: si manda il
  // clock avanti rispetto al created_at (reale) della routine
  clock = Math.max(clock, Date.now() + 3 * 60_000)
  return r.id
}

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-polls-test-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

beforeEach(() => {
  // clock controllato ma coerente con created_at (Date.now() reale in createRoutine)
  clock = Date.now()
  mcpOutput = '[]'
  mcpCalls.length = 0
  h.tools = [{ name: 'mcp__gmail__search', description: 'search', annotations: { readOnlyHint: true } }]
  h.unreachable.length = 0
  const d = db()
  d.exec('DELETE FROM jobs')
  d.exec('DELETE FROM routines')
  d.exec('DELETE FROM settings')
})

describe('tickConnectorPolls: id nuovi, prima esecuzione silenziosa', () => {
  it('la prima esecuzione registra gli id esistenti SENZA eventi', async () => {
    const id = mkPollRoutine({})
    mcpOutput = JSON.stringify({ messages: [{ id: 'm1', subject: 'a' }, { id: 'm2', subject: 'b' }] })
    await tickConnectorPolls(pollDeps(), clock)
    expect(mcpCalls).toHaveLength(1)
    expect(listJobs(db())).toHaveLength(0) // nessun evento
    expect(getSetting(`trigger.seen.${id}`, { ids: [], primed: false })).toEqual({ ids: ['m1', 'm2'], primed: true })
  })

  it('le esecuzioni successive producono un evento SOLO per gli id nuovi', async () => {
    const id = mkPollRoutine({ preset: 'email' })
    mcpOutput = JSON.stringify({ messages: [{ id: 'm1' }] })
    await tickConnectorPolls(pollDeps(), clock) // prime silenzioso
    mcpOutput = JSON.stringify({ messages: [{ id: 'm1' }, { id: 'm2', subject: 'Nuova!' }] })
    clock += 3 * 60_000
    await tickConnectorPolls(pollDeps(), clock)
    const jobs = listJobs(db())
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.kind).toBe('routine-run')
    expect(jobs[0]!.payload.event).toMatchObject({ source: 'connector_poll', title: 'Nuova email: Nuova!' })
    expect((jobs[0]!.payload.event as { data?: unknown }).data).toMatchObject({ id: 'm2', subject: 'Nuova!' })
    // gli id visti ora comprendono anche m2
    expect(getSetting(`trigger.seen.${id}`, { ids: [], primed: false }).ids).toEqual(['m1', 'm2'])
  })

  it('nessun id nuovo → nessun job, nessun secondo evento per lo stesso id', async () => {
    mkPollRoutine({})
    mcpOutput = JSON.stringify({ messages: [{ id: 'm1' }] })
    await tickConnectorPolls(pollDeps(), clock)
    clock += 3 * 60_000
    await tickConnectorPolls(pollDeps(), clock)
    clock += 3 * 60_000
    await tickConnectorPolls(pollDeps(), clock)
    expect(mcpCalls).toHaveLength(3)
    expect(listJobs(db())).toHaveLength(0)
  })

  it('rispetta l\'intervallo: prima dell\'intervalMin non chiama il tool (claim con last_poll)', async () => {
    const id = mkPollRoutine({})
    await tickConnectorPolls(pollDeps(), clock) // prime
    clock += 60_000 // 1 minuto < 2
    await tickConnectorPolls(pollDeps(), clock)
    expect(mcpCalls).toHaveLength(1)
    clock += 2 * 60_000
    await tickConnectorPolls(pollDeps(), clock)
    expect(mcpCalls).toHaveLength(2)
    void id
  })

  it('routine in pausa: nessun poll', async () => {
    const id = mkPollRoutine({})
    db().prepare('UPDATE routines SET enabled = 0 WHERE id = ?').run(id)
    await tickConnectorPolls(pollDeps(), clock)
    expect(mcpCalls).toHaveLength(0)
  })

  it('tool che fallisce: poll silenzioso (nessun job), si riprova al prossimo intervallo', async () => {
    const deps: PollDeps = {
      db: db(), emit: () => undefined, now: () => clock,
      callMcpTool: async () => { throw new Error('connettore needs_auth') }
    }
    mkPollRoutine({})
    await expect(tickConnectorPolls(deps, clock)).resolves.toBeUndefined()
    expect(listJobs(db())).toHaveLength(0)
    // il last_poll è stato registrato: il prossimo tentativo è tra l'intervallo
    clock += 60_000
    await tickConnectorPolls(deps, clock)
    // (nessun crash: il test arriva qui)
  })
})

describe('preset calendar_event: job a start - offsetMinutes', () => {
  it('programma il job N minuti prima dell\'evento, uno per evento nuovo', async () => {
    const start = clock + 5 * 3_600_000 // tra 5 ore
    mkPollRoutine({ preset: 'calendar_event', idField: 'events[].id', offsetMinutes: 10 })
    mcpOutput = JSON.stringify({
      events: [
        { id: 'e1', summary: 'Standup', start: { dateTime: new Date(start).toISOString() } },
        { id: 'e2', summary: 'Passato', start: { dateTime: new Date(clock - 3_600_000).toISOString() } },
        { id: 'e3', summary: 'Tra due giorni', start: { dateTime: new Date(clock + 50 * 3_600_000).toISOString() } }
      ]
    })
    await tickConnectorPolls(pollDeps(), clock)
    const jobs = listJobs(db())
    // primo poll: prima esecuzione → silenzioso per il preset? NO: gli eventi
    // validi vengono programmati subito (la "prima esecuzione silenziosa" del
    // preset evita solo di ri-programmare eventi già visti)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.run_at).toBe(start - 10 * 60_000)
    expect(jobs[0]!.payload.event).toMatchObject({ source: 'calendar_event', title: 'Evento del calendario in arrivo: Standup' })
    // al prossimo poll gli stessi eventi NON generano nuovi job
    clock += 3 * 60_000
    await tickConnectorPolls(pollDeps(), clock)
    expect(listJobs(db())).toHaveLength(1)
  })

  it('evento con start - offset già passato: il job parte subito (meglio tardi che mai)', async () => {
    mkPollRoutine({ preset: 'calendar_event', idField: 'events[].id', offsetMinutes: 10 })
    const now = clock
    const start = now + 2 * 60_000
    mcpOutput = JSON.stringify({ events: [{ id: 'e9', summary: 'Imminente', start: { dateTime: new Date(start).toISOString() } }] })
    await tickConnectorPolls(pollDeps(), clock)
    const jobs = listJobs(db())
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.run_at).toBe(now) // start-10min è nel passato → ora
  })
})

describe('validazione del trigger alla creazione (routines:create-trigger)', () => {
  const events: SandbotEvent[] = []
  const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(
    (e) => events.push(e),
    { poke: () => undefined } as unknown as JobWorker
  )

  it('tool non read-only → trigger RIFIUTATO', async () => {
    h.tools = [{ name: 'mcp__gmail__send', description: 'invia', annotations: { readOnlyHint: false } }]
    await expect(
      api['routines:create-trigger']!([AGENT, 'NoRO', 'x', { type: 'connector_poll', connectorId: 'gmail', tool: 'mcp__gmail__send', intervalMin: 5, idField: 'messages[].id' }])
    ).rejects.toThrow('sola lettura')
  })

  it('tool inesistente sul connettore → rifiutato; connettore irraggiungibile → rifiutato', async () => {
    h.tools = [{ name: 'mcp__gmail__search', description: 's', annotations: { readOnlyHint: true } }]
    await expect(
      api['routines:create-trigger']!([AGENT, 'NoTool', 'x', { type: 'connector_poll', connectorId: 'gmail', tool: 'mcp__gmail__altro', intervalMin: 5, idField: 'messages[].id' }])
    ).rejects.toThrow('non disponibile')
    h.unreachable.push('sconosciuto')
    await expect(
      api['routines:create-trigger']!([AGENT, 'NoConn', 'x', { type: 'connector_poll', connectorId: 'sconosciuto', tool: 't', intervalMin: 5, idField: 'messages[].id' }])
    ).rejects.toThrow('non raggiungibile')
  })

  it('trigger valido: routine creata col trigger_json, webhook col token generato', async () => {
    h.tools = [{ name: 'mcp__gmail__search', description: 's', annotations: { readOnlyHint: true } }]
    const created = await api['routines:create-trigger']!([
      AGENT, 'Mail', 'x',
      { type: 'connector_poll', connectorId: 'gmail', tool: 'mcp__gmail__search', intervalMin: 5, idField: 'messages[].id', preset: 'email' },
      'Europe/Rome'
    ]) as { id: number; trigger: RoutineTrigger }
    expect(created.trigger).toMatchObject({ type: 'connector_poll', preset: 'email' })
    const hook = await api['routines:create-trigger']!([AGENT, 'Hook', 'x', { type: 'webhook' }]) as { trigger: RoutineTrigger & { token: string } }
    expect(hook.trigger.token).toMatch(/^[A-Za-z0-9_-]{20,}$/)
  })

  it('fuso orario non valido → rifiutato', async () => {
    await expect(
      api['routines:create-trigger']!([AGENT, 'Tz', 'x', { type: 'presence_return' }, 'Roma/Italia'])
    ).rejects.toThrow('Fuso orario')
  })
})
