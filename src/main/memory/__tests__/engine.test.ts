// Fase memoria-engramma (M1): il motore nel demone — src/main/memory/engine.ts
// apre Engine su <dataDir>/memory UNA volta per processo, con actor 'homun' e
// modelDir <dataDir>/models; le celle dei bot con actor 'homun:bot-<id>', la
// cella utente con l'actor di chi scrive. Dopo close ogni chiamata risponde
// CLOSED e il demone lo gestisce senza errori nei log. Nessun ripiego
// silenzioso: se il modulo non si carica, lo stato dell'errore è leggibile.
//
// Qui il modulo VERO da vendor/engramma (pretest lo prepara): i test girano
// su cartelle temporanee, mai sui dati veri.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-mem-engine-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const eng = () => import('../engine')

describe('fase memoria-engramma M1: il motore nel demone', () => {
  it('il modulo nativo si carica e dice la sua versione', async () => {
    const { engrammaModule } = await eng()
    const m = await engrammaModule()
    expect(m).not.toBeNull()
    expect(typeof m!.version()).toBe('string')
  })

  it('openMemoryEngine apre su <dataDir>/memory con actor homun; le celle esistono', async () => {
    const e = await eng()
    const dir = join(ROOT, 'd1')
    const st = await e.openMemoryEngine({ dataDir: dir })
    expect(st.available).toBe(true)
    expect(st.version).toBeTruthy()
    const engine = await e.memoryEngine()
    expect(await engine.cells()).toEqual([])
    const bot = await e.botCell('agent_ab12cd34')
    expect(bot.name).toBe('bot-agent_ab12cd34')
    // il registro dice QUALE bot ha scritto: actor per cella
    const n = await bot.put({ body: 'prova', source: 'homun:chat/agent_ab12cd34/1', confidence: 'stated' })
    const ops = await (await e.botCell('agent_ab12cd34')).changesSince(0)
    expect('ops' in ops && ops.ops.some((o) => o.actor === 'homun:bot-agent_ab12cd34' && o.kind === 'put_note')).toBe(true)
    // la cella utente scrive con l'actor del bot o dell'interfaccia
    const userByBot = await e.userCell('agent_ab12cd34')
    const userByUi = await e.userCell(null)
    await userByBot.put({ body: 'condivisa dal bot', source: 's', confidence: 'stated' })
    await userByUi.put({ body: 'condivisa dalla UI', source: 's', confidence: 'stated' })
    const userOps = await userByUi.changesSince(0)
    const actors = 'ops' in userOps ? userOps.ops.map((o) => o.actor) : []
    expect(actors).toContain('homun:bot-agent_ab12cd34')
    expect(actors).toContain('homun:user')
    void n
    await e.closeMemoryEngine()
  })

  it('dopo close ogni chiamata risponde CLOSED, gestito senza errori nei log', async () => {
    const e = await eng()
    await e.openMemoryEngine({ dataDir: join(ROOT, 'd2') })
    const cell = await e.botCell('agent_x')
    await cell.put({ body: 'x', source: 's', confidence: 'stated' })
    await e.closeMemoryEngine()
    // le chiamate dopo close NON lanciano: rispondono con code CLOSED
    // (napi può lanciare in modo SINCRONO: si cattura anche quello)
    const r = await Promise.resolve()
      .then(() => cell.put({ body: 'y', source: 's', confidence: 'stated' }))
      .then(
        (v) => ({ ok: true as const, v }),
        (err: { code?: string }) => ({ ok: false as const, code: err.code })
      )
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('CLOSED')
    await expect(e.memoryEngine()).rejects.toThrow()
    expect(e.memoryEngineError()).toMatch(/chiuso|CLOSED/i)
    // close due volte non è un errore
    await e.closeMemoryEngine()
  })

  it('il modulo non si carica → nessun ripiego silenzioso: l\'errore è chiaro', async () => {
    // una cartella senza index.js: il caricamento fallisce e lo stato lo dice
    const empty = join(ROOT, 'no-module')
    mkdirSync(empty, { recursive: true })
    const prev = process.env.SANDBOT_ENGRAMMA_DIR
    process.env.SANDBOT_ENGRAMMA_DIR = empty
    try {
      // reset del cache del modulo per forzare un nuovo tentativo
      const e = await eng()
      e.resetEngrammaModuleCacheForTests()
      const m = await e.engrammaModule()
      expect(m).toBeNull()
      const st = await e.openMemoryEngine({ dataDir: join(ROOT, 'd3') })
      expect(st.available).toBe(false)
      expect(st.error).toMatch(/engramma/i)
      await expect(e.memoryEngine()).rejects.toThrow(/engramma/i)
    } finally {
      // process.env coerce a stringa: undefined si ripristina CANCELLANDO
      if (prev === undefined) delete process.env.SANDBOT_ENGRAMMA_DIR
      else process.env.SANDBOT_ENGRAMMA_DIR = prev
      const e = await eng()
      e.resetEngrammaModuleCacheForTests()
    }
  })

  it('modelStatus dice se il modello c\'è (senza scaricare mai nulla)', async () => {
    const e = await eng()
    await e.openMemoryEngine({ dataDir: join(ROOT, 'd4') })
    const st = await e.memoryEngineStatus()
    expect(st.available).toBe(true)
    expect(st.model.present).toBe(false) // modelDir vuoto: il modello NON si scarica da solo
    await e.closeMemoryEngine()
  })

  it('i nomi delle celle sanificano gli id (a-z 0-9 - _), stabili', async () => {
    const { botCellName } = await eng()
    expect(botCellName('agent_ab12cd34')).toBe('bot-agent_ab12cd34')
    expect(botCellName('agent_AB.CD')).toBe('bot-agent_ab-cd') // minuscolo, caratteri estranei → '-'
    expect(botCellName('../evil')).toBe('bot-..-evil'.replace(/[^a-z0-9_-]/g, '-'))
    expect(botCellName('a'.repeat(100))).toHaveLength(4 + 64)
  })

  it('le ricerche non vedono le celle inesistenti: ensureSearchCells le crea vuote', async () => {
    const e = await eng()
    await e.openMemoryEngine({ dataDir: join(ROOT, 'd5') })
    // engine.search risponde NOT_FOUND se una cella manca: il servizio le garantisce
    await e.ensureSearchCells('agent_q')
    const engine = await e.memoryEngine()
    expect(new Set(await engine.cells())).toEqual(new Set(['bot-agent_q', 'utente']))
    const hits = await engine.search(['bot-agent_q', 'utente'], { text: 'qualsiasi', k: 5 })
    expect(hits).toEqual([])
    await e.closeMemoryEngine()
  })
})

describe('fase memoria-engramma M1: embedPending in fondo alla coda', () => {
  it('il job memory-embed si accoda una volta per agente (coalesce), in fondo', async () => {
    const { enqueueEmbedPending, EMBED_JOB_DELAY_MS } = await eng()
    const { DatabaseSync } = await import('node:sqlite')
    const { JOBS_DDL, listJobs } = await import('../../store/jobs')
    const db = new DatabaseSync(':memory:')
    db.exec(JOBS_DDL)
    const now = 1_000_000
    enqueueEmbedPending(db, 'agent_k', now)
    enqueueEmbedPending(db, 'agent_k', now + 1000)
    enqueueEmbedPending(db, 'agent_j', now + 1000)
    const jobs = listJobs(db).filter((j) => j.kind === 'memory-embed')
    expect(jobs.map((j) => j.agent_id).sort()).toEqual(['agent_j', 'agent_k'])
    expect(jobs.find((j) => j.agent_id === 'agent_k')!.run_at).toBe(now + EMBED_JOB_DELAY_MS)
    db.close()
  })

  it('embedPendingAll senza modello non fa nulla e non lancia (il modello non si scarica da solo)', async () => {
    const e = await eng()
    await e.openMemoryEngine({ dataDir: join(ROOT, 'd6') })
    await (await e.botCell('agent_e')).put({ body: 'da incorporare', source: 's', confidence: 'stated' })
    expect(await e.embedPendingAll()).toBe(0)
    await e.closeMemoryEngine()
    // anche a motore chiuso: silenzio, nessun errore
    expect(await e.embedPendingAll()).toBe(0)
  })
})

describe('fase memoria-engramma M8: dove si cerca il modulo nell\'app impacchettata', () => {
  it('per DEFAULT si guarda in process.resourcesPath/vendor/engramma (extraResources), prima del repo', async () => {
    const { engrammaDirCandidates } = await import('../engine')
    const proc = process as NodeJS.Process & { resourcesPath?: string }
    const prev = proc.resourcesPath
    proc.resourcesPath = '/Applications/Homun.app/Contents/Resources'
    try {
      const env = { ...process.env }
      delete env.SANDBOT_ENGRAMMA_DIR
      const c = engrammaDirCandidates(env)
      expect(c[0]).toBe('/Applications/Homun.app/Contents/Resources/vendor/engramma')
    } finally {
      proc.resourcesPath = prev
    }
  })
})
