// Test dei webhook dei trigger (fase 6): endpoint locale POST /hooks/<id>
// con Authorization: Bearer <token per routine>. Su server HTTP reale in
// loopback: token sbagliato → 401, corpo oltre 64 KB → 413, routine assente
// o in pausa → 404, richiesta valida → job 'routine-run' accodato con
// l'evento nel payload. Store reale su directory temporanea.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

const { setDataDir, dataDir, db, createRoutine, updateRoutine } = await import('../../main/store/db')
const { handleWebhook, WEBHOOK_MAX_BODY } = await import('../webhooks')
const { listJobs } = await import('../../main/store/jobs')
import type { RoutineTrigger } from '../../shared/types'

let server: Server
let base: string
const TRIGGER: RoutineTrigger = { type: 'webhook', token: 'token-di-prova' }
let routineId: number

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-hooks-test-'))
  setDataDir(dir)
  dataDir()
  db()
  server = createServer((req, res) => {
    void handleWebhook(req, res, { db: db(), emit: () => undefined, now: () => Date.now() })
      .then((handled) => { if (!handled) res.destroy() })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dataDir(), { recursive: true, force: true })
})

beforeEach(() => {
  db().exec('DELETE FROM jobs')
  db().exec('DELETE FROM routines')
  routineId = createRoutine('agent_w', 'Hook', 'gestisci l\'evento', '0 0 1 1 *', {
    trigger: TRIGGER
  }).id
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })

describe('webhook dei trigger', () => {
  it('token sbagliato o assente → 401, nessun job', async () => {
    expect((await post(`/hooks/${routineId}`, { a: 1 })).status).toBe(401)
    expect((await post(`/hooks/${routineId}`, { a: 1 }, { authorization: 'Bearer sbagliato' })).status).toBe(401)
    expect(listJobs(db())).toHaveLength(0)
  })

  it('corpo oltre 64 KB → 413, nessun job', async () => {
    const big = 'x'.repeat(WEBHOOK_MAX_BODY + 1)
    const res = await post(`/hooks/${routineId}`, big, { authorization: `Bearer ${TRIGGER.token}` })
    expect(res.status).toBe(413)
    expect(listJobs(db())).toHaveLength(0)
  })

  it('routine inesistente o non-webhook → 404', async () => {
    expect((await post('/hooks/99999', { a: 1 }, { authorization: `Bearer ${TRIGGER.token}` })).status).toBe(404)
    const plain = createRoutine('agent_w', 'NoHook', 'x', '0 0 1 1 *')
    expect((await post(`/hooks/${plain.id}`, { a: 1 }, { authorization: `Bearer ${TRIGGER.token}` })).status).toBe(404)
  })

  it('routine in pausa → 404 (il trigger non scatta finché è ferma)', async () => {
    updateRoutine(routineId, { enabled: 0 })
    const res = await post(`/hooks/${routineId}`, { a: 1 }, { authorization: `Bearer ${TRIGGER.token}` })
    expect(res.status).toBe(404)
    expect(listJobs(db())).toHaveLength(0)
  })

  it('richiesta valida → 200 e job routine-run con l\'evento nel payload', async () => {
    const res = await post(`/hooks/${routineId}`, { hello: 'world' }, { authorization: `Bearer ${TRIGGER.token}` })
    expect(res.status).toBe(200)
    const jobs = listJobs(db())
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.kind).toBe('routine-run')
    expect(jobs[0]!.agent_id).toBe('agent_w')
    // fase 17c correzioni (D1): titolo inglese per il modello + kind per la bolla UI
    expect(jobs[0]!.payload.event).toMatchObject({ source: 'webhook', kind: 'webhook', title: 'Webhook received', data: { hello: 'world' } })
    expect(jobs[0]!.payload.routineId).toBe(routineId)
  })

  it('corpo non JSON: entra come testo grezzo nell\'evento', async () => {
    const res = await post(`/hooks/${routineId}`, 'solo testo', {
      authorization: `Bearer ${TRIGGER.token}`,
      'content-type': 'text/plain'
    })
    expect(res.status).toBe(200)
    expect(listJobs(db())[0]!.payload.event).toMatchObject({ data: 'solo testo' })
  })

  it('solo POST: una GET sullo stesso path non è un webhook (connessione chiusa)', async () => {
    await expect(fetch(`${base}/hooks/${routineId}`)).rejects.toThrow()
  })
})
