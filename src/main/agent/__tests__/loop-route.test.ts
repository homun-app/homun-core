// Fase 18b (H8): il turno con la catena delle riserve sullo stack VERO —
// niente mock del llm: due server finti su 127.0.0.1 (A risponde SEMPRE 429
// "usage limit", B consegna in SSE con send_to_user e usage) e lo store reale
// in una cartella mkdtemp del percorso ESPLICITO /var/folders/… (mai $TMPDIR
// né os.tmpdir()). Chiavi finte sk-test-*.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { ProviderConfig } from '../../../shared/types'
import * as store from '../../store/db'
import { runTurn } from '../loop'
import { resetRouteHealth } from '../route-health'

/** Il percorso esplicito richiesto dai vincoli (MAI $TMPDIR né os.tmpdir()). */
const TMP_ROOT = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/'

let dir: string
let serverA: Server
let serverB: Server
let portA = 0
let portB = 0
const hits: { a: number; b: number } = { a: 0, b: 0 }
const emit = (): void => undefined

/** La risposta di B: UNA tool call send_to_user alla prima chiamata, testo dopo. */
let bCalls = 0

const sse = (lines: unknown[]): string => lines.map((l) => 'data: ' + JSON.stringify(l)).join('\n\n') + '\n\ndata: [DONE]\n\n'

beforeAll(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-loop-route-'))
  store.setDataDir(dir)
  store.db()

  // A: sempre 429 con body "usage limit" (il caso Ollama cloud della settimana)
  serverA = createServer((_req, res) => {
    hits.a++
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'usage limit reached' } }))
  })
  await new Promise<void>((resolve) => serverA.listen(0, '127.0.0.1', resolve))
  portA = (serverA.address() as { port: number }).port

  // B: consegna. POST → SSE mistral (tool call o testo, con usage); GET /v1/models → elenco
  serverB = createServer((req, res) => {
    if (req.method === 'GET') {
      hits.b++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm-b', display_name: 'B Model' }] }))
      return
    }
    hits.b++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    bCalls++
    const chunks = bCalls === 1
      ? [
          { id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'send_to_user', arguments: JSON.stringify({ text: 'consegnato dalla riserva' }) } }] }, finish_reason: null }] },
          { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }
        ]
      : [
          { id: 'x', choices: [{ index: 0, delta: { content: 'testo libero' }, finish_reason: null }] },
          { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 } }
        ]
    res.end(sse(chunks))
  })
  await new Promise<void>((resolve) => serverB.listen(0, '127.0.0.1', resolve))
  portB = (serverB.address() as { port: number }).port

  const pa: ProviderConfig = { id: 'pa', name: 'A (limite)', kind: 'mistral', baseUrl: `http://127.0.0.1:${portA}`, apiKey: 'sk-test-a', enabled: true }
  const pb: ProviderConfig = { id: 'pb', name: 'B (riserva)', kind: 'mistral', baseUrl: `http://127.0.0.1:${portB}`, apiKey: 'sk-test-b', enabled: true }
  store.saveProviders([pa, pb])
  store.setSetting('models.fallbackChain', [{ providerId: 'pb', model: 'm-b' }])
  // H1.3 end-to-end: B non è locale e m-b non è a catalogo → il prezzo custom
  // fa il costo della riga di usage
  store.setSetting('providers.modelPrices', { pb: { 'm-b': { input: 2, output: 4 } } })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  return Promise.all([
    new Promise<void>((r) => serverA.close(() => r())),
    new Promise<void>((r) => serverB.close(() => r()))
  ])
})

beforeEach(() => {
  store.db().exec('DELETE FROM entries')
  store.db().exec('DELETE FROM model_usage')
  store.db().exec('DELETE FROM agents')
  resetRouteHealth()
  hits.a = 0
  hits.b = 0
  bCalls = 0
})

describe('fase 18b (H8): catena delle riserve sullo stack vero (server finti su 127.0.0.1)', () => {
  it('primario 429 → riserva su ALTRO provider: consegna, notice modelFallbackRoute, usage solo della riserva col prezzo custom', async () => {
    const agent = store.createAgent('RouteBot')
    store.updateAgent(agent.id, { providerId: 'pa', model: 'm-a' })
    await runTurn(agent.id, 'ciao', emit)

    // consegna: la send di B è arrivata all'utente
    const sent = store.getEntries(agent.id).filter((e) => e.kind === 'send-message')
    expect(sent.some((e) => e.content === 'consegnato dalla riserva')).toBe(true)
    // la notice di passaggio d'anello (H2.4)
    const notice = store.getEntries(agent.id).find((e) => e.kind === 'notice' && (e.meta?.ui as { id?: string } | undefined)?.id === 'notice.modelFallbackRoute')
    expect(notice).toBeTruthy()
    expect((notice!.meta!.ui as { values?: Record<string, string> }).values).toMatchObject({ model: 'm-a', provider: 'A (limite)', fallback: 'm-b', fallbackProvider: 'B (riserva)' })
    // usage: righe di B, NESSUNA di A (la chiamata fallita non si registra)
    const rows = store.db().prepare('SELECT * FROM model_usage').all() as Array<Record<string, unknown>>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.provider_id === 'pb')).toBe(true)
    expect(rows.every((r) => r.provider_kind === 'mistral')).toBe(true)
    // H1.3: il costo dal prezzo personalizzato (2 $/M in, 4 $/M out)
    for (const r of rows) {
      expect(r.cost_usd as number).toBeGreaterThan(0)
    }
    expect(store.getEntries(agent.id).some((e) => e.kind === 'event' && e.meta?.turnEnd === 'FINISHED')).toBe(true)
  }, 20_000)

  it('il turno SUCCESSIVO parte dalla riserva: A non riceve chiamate (raffreddato), notice modelRouteCooled', async () => {
    const agent = store.createAgent('RouteBot2')
    store.updateAgent(agent.id, { providerId: 'pa', model: 'm-a' })
    // primo turno: 429 su A, consegna da B. K6: con una riserva utilizzabile
    // dietro, il loop passa maxRetries 0 e NEANCHÉ i retry H1.1 scattano
    // (mistral-conversations non ha retry propri dell'SDK) → UNA sola
    // richiesta ad A prima del passaggio d'anello; prima di K6 erano 3
    await runTurn(agent.id, 'uno', emit)
    const aAfterFirst = hits.a
    expect(aAfterFirst).toBe(1)
    store.db().exec('DELETE FROM entries')

    // secondo turno: A è in pausa (10 minuti) — parte da B (risponde testo)
    await runTurn(agent.id, 'due', emit)
    expect(hits.a).toBe(aAfterFirst) // A non è stato toccato
    expect(hits.b).toBeGreaterThan(0)
    const cooled = store.getEntries(agent.id).find((e) => e.kind === 'notice' && (e.meta?.ui as { id?: string } | undefined)?.id === 'notice.modelRouteCooled')
    expect(cooled).toBeTruthy()
    const vals = (cooled!.meta!.ui as { values?: Record<string, string> }).values!
    expect(vals.model).toBe('m-a')
    expect(vals.provider).toBe('A (limite)')
    expect(vals.until).toMatch(/^\d{2}:\d{2}$/)
    expect(vals.fallback).toBe('m-b')
    // il turno consegna lo stesso (testo libero → fallback send del recupero)
    expect(store.getEntries(agent.id).some((e) => e.kind === 'send-message')).toBe(true)
  }, 20_000)
})
