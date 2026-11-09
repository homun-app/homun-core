// Fase memoria-engramma · correzioni (C8): il modello a caldo. Dopo il
// download dalla sezione il demone NON chiude e riapre più il motore: la
// v0.4.2 collega l'embedder da sola (pullModel sul motore APERTO). Il test
// serve il modello VERO di ~/.cache/engramma/models da un server locale su
// 127.0.0.1 con ENGRAMMA_PULL_BASE: nessuna rete.
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync, createReadStream } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const MODEL_CACHE = join(homedir(), '.cache', 'engramma', 'models', 'granite-embedding-97m-multilingual-r2')

const ROOTS: string[] = []
const SERVERS: Server[] = []
afterAll(async () => {
  const { closeMemoryEngine } = await import('../../main/memory/engine')
  await closeMemoryEngine()
  for (const r of ROOTS) rmSync(r, { recursive: true, force: true })
  for (const s of SERVERS) await new Promise((res) => s.close(() => res(undefined)))
})

/** Il server locale che serve i percorsi agganciati dalla cartella del modello vero. */
function startModelServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // {repo}/resolve/{revisione}/{file} — la base è la NOSTRA
      const m = /^\/ibm-granite\/granite-embedding-97m-multilingual-r2\/resolve\/([0-9a-f]{40})\/(.+)$/.exec(req.url ?? '')
      const file = m ? join(MODEL_CACHE, m[1]!, m[2]!) : ''
      if (!file || !existsSync(file)) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      res.statusCode = 200
      res.setHeader('content-length', statSync(file).size)
      createReadStream(file).pipe(res)
    })
    server.listen(0, '127.0.0.1', () => {
      SERVERS.push(server)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

describe.skipIf(!existsSync(MODEL_CACHE))('fase memoria-engramma · correzioni C8: model-pull collega il modello a caldo', () => {
  it('present passa a true e la ricerca diventa ibrida SENZA riapertura (la cella di prima continua a vivere)', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-mem-pull-'))
    ROOTS.push(ROOT)
    const DATA = join(ROOT, 'data')
    const { setDataDir } = await import('../../main/store/db')
    setDataDir(DATA)
    const e = await import('../../main/memory/engine')
    await e.closeMemoryEngine()
    const st0 = await e.openMemoryEngine({ dataDir: DATA })
    expect(st0.available).toBe(true)
    expect(st0.model.present).toBe(false) // modelDir vuota: il modello non c'è

    // una cella APERTA PRIMA del download: la riapertura la chiuderebbe
    // (CLOSED per sempre), il collegamento a caldo la lascia vivere
    const cellBefore = await e.botCell('agent_pull')
    await cellBefore.put({ body: 'nota scritta prima del download del modello', source: 's', confidence: 'stated' })

    const port = await startModelServer()
    const prevBase = process.env.ENGRAMMA_PULL_BASE
    process.env.ENGRAMMA_PULL_BASE = `http://127.0.0.1:${port}`
    try {
      // la RPC del click nella sezione
      const { buildApiMethods } = await import('../api')
      const events: import('../../shared/types').SandbotEvent[] = []
      const api = buildApiMethods((ev) => events.push(ev), { poke: () => undefined } as never)
      expect(api['memory:model-pull']([])).toEqual({ started: true })
      // si aspetta la fine (il download da 127.0.0.1 dei ~400 MB)
      const deadline = Date.now() + 120_000
      while (!events.some((ev) => ev.type === 'memory' && ev.phase === 'model-pull' && ev.finished)) {
        if (Date.now() > deadline) throw new Error('il download dal server locale non è finito in 120 s')
        await new Promise((r) => setTimeout(r, 100))
      }
      const failed = events.find((ev) => ev.type === 'memory' && ev.phase === 'model-pull' && ev.finished && (ev as { error?: string }).error)
      expect(failed).toBeUndefined()

      // 1. present passa a true (col collegamento a caldo è immediato; la
      // vecchia riapertura ci mette il tempo di ricaricare il modello)
      const deadlinePresent = Date.now() + 60_000
      for (;;) {
        if ((await e.memoryEngineStatus()).model.present) break
        if (Date.now() > deadlinePresent) throw new Error('modelStatus().present resta false dopo il download')
        await new Promise((r) => setTimeout(r, 100))
      }

      // 2. la CELLA di prima continua a vivere (nessuna riapertura: close
      // l'avrebbe chiusa per sempre) e ci si scrive ancora
      await cellBefore.put({ body: 'nota scritta dopo il download, stessa cella', source: 's', confidence: 'stated' })
      expect(await cellBefore.list({ limit: 10 })).toHaveLength(2)

      // 3. la ricerca diventa IBRIDA: si incorporano le note e il explain
      // porta il rank semantico (vector senza modello sarebbe MODEL_MISSING)
      expect(await cellBefore.embedPending()).toBe(2)
      const engine = await e.memoryEngine()
      const hits = await engine.search(['bot-agent_pull'], { text: 'cosa c\'era prima del download?', k: 5, mode: 'hybrid', explain: true })
      expect(hits.length).toBeGreaterThanOrEqual(1)
      expect(hits.some((h) => h.explain?.semanticRank !== undefined)).toBe(true)
    } finally {
      if (prevBase === undefined) delete process.env.ENGRAMMA_PULL_BASE
      else process.env.ENGRAMMA_PULL_BASE = prevBase
    }
  })
})
