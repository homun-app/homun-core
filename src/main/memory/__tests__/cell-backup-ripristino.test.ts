// Fase memoria-engramma v0.6.19 (E1): il ripristino scritto in docs/MEMORIA.md,
// provato su una copia col .node v0.4.3.
//
// La migrazione delle celle (schema 12 → 24) non torna indietro, e un Homun
// precedente aperto sulle celle già aggiornate le rovina (il v0.4.3 non ha
// la guardia SCHEMA_TOO_NEW): tornare indietro vuol dire rimettere la copia
// fatta prima. Il documento dice quali cartelle e in che ordine, con l'app
// chiusa; qui la stessa sequenza si esegue su una copia di prova — le celle
// della cella d'oro, il motore nuovo che le aggiorna, il ripristino a mano —
// e poi il .node v0.4.3 deve riaprire le celle com'erano.
//
// Il .node v0.4.3 non sta nel repo: la cartella che lo tiene (index.js
// accanto) si dice con SANDBOT_TEST_ENGRAMMA_V043_DIR. Senza, i test che
// aprono col motore vecchio saltano (describe.skipIf); il documento invece
// si controlla sempre.
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const ROOT = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-mem-ripristino-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const REPO = join(import.meta.dirname, '..', '..', '..', '..')
const DOC = join(REPO, 'docs', 'MEMORIA.md')
const FIXTURE = join(import.meta.dirname, 'fixtures', 'engramma-v0.4.3')
const GOLDEN_SHA = 'fd015fa704a7dc440aef577159240be6bba11460a615a06d584392ae4aa1e521'
const GOLDEN_BODIES = [
  'Le riunioni del lunedì si preparano il venerdì pomeriggio.',
  'Per i report si usa il template «Riepilogo settimanale».'
]

/** La cartella col .node v0.4.3 (index.js accanto): SANDBOT_TEST_ENGRAMMA_V043_DIR. */
const V043 = process.env.SANDBOT_TEST_ENGRAMMA_V043_DIR
const haV043 = !!V043 && existsSync(join(V043, 'index.js')) && existsSync(join(V043, 'engramma.darwin-arm64.node'))

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const eng = () => import('../engine')
const cb = () => import('../cell-backup')
/** Lo schema che il motore di oggi sostiene (buildInfo), letto PRIMA che un test punti il modulo al v0.4.3. */
const ENGINE_SCHEMA: number = (await (await eng()).engrammaModule())!.buildInfo!().schema
/** Lo schema di una cella letto senza il motore (la cartella di servizio, se serve, resta nella base del test). */
const leggi = async (file: string) => (await cb()).readCellSchema(file, { mkdtemp: (p) => mkdtempSync(join(ROOT, p)) })

describe('E1: il ripristino è scritto in docs/MEMORIA.md', () => {
  // il documento si legge DENTRO i test: se manca fallisce il test, non il file, e la pulizia gira lo stesso
  const doc = (): string => readFileSync(DOC, 'utf8')

  it('dice quali cartelle (la copia memory-backup-schema…, la memoria aggiornata memory-migrata-…, la cartella dati) e in che ordine, con Homun chiuso prima', async () => {
    const testo = doc()
    const { BACKUP_PREFIX } = await cb()
    expect(testo).toContain('~/Library/Application Support/sandbot/data')
    expect(testo).toContain(BACKUP_PREFIX)
    expect(testo).toContain('memory-migrata-')
    // l'ordine del documento è quello del ripristino: PRIMA si esce, poi si sposta la memoria aggiornata, poi si rimette la copia (le frasi dei PASSI: i nomi delle cartelle compaiono prima, nella tabella)
    const esci = testo.indexOf('Esci da Homun')
    const sposta = testo.indexOf('rinomina la cartella `memory` in')
    const rimette = testo.indexOf('nomina la copia `memory`')
    expect(esci).toBeGreaterThan(0)
    expect(sposta).toBeGreaterThan(esci)
    expect(rimette).toBeGreaterThan(sposta)
    expect(testo).toMatch(/Homun chiuso/)
  })

  it('dice che la memoria aggiornata non si cancella (ci sono le note scritte dopo) e che un Homun precedente sulle celle aggiornate le rovina', () => {
    expect(doc()).toMatch(/scritte dopo/)
    expect(doc()).toMatch(/non si cancella/)
    expect(doc()).toMatch(/rovina/)
  })

  it('tappa 3: dice quanto spazio serve per copiare e aggiornare — il doppio di memory/ più 256 MB, non più i 5 GB delle build', () => {
    const testo = doc()
    expect(testo).toMatch(/doppio della dimensione di `memory\/` più 256 MB/)
    expect(testo).not.toMatch(/più 5 GB/)
    // l’avviso dell’interfaccia resta citato com’è
    expect(testo).toContain('liberane N GB')
  })

  it('ARCHITETTURA.md rimanda a questa guida accanto a data/memory/', () => {
    const arch = readFileSync(join(REPO, 'docs', 'ARCHITETTURA.md'), 'utf8')
    expect(arch).toContain('MEMORIA.md')
  })
})

describe.skipIf(!haV043)('E1: il ripristino provato su una copia, col .node v0.4.3', () => {
  const prev = process.env.SANDBOT_ENGRAMMA_DIR
  afterEach(async () => {
    await (await eng()).closeMemoryEngine()
    if (prev === undefined) delete process.env.SANDBOT_ENGRAMMA_DIR
    else process.env.SANDBOT_ENGRAMMA_DIR = prev
    ;(await eng()).resetEngrammaModuleCacheForTests()
  })

  it('come sta scritto nel documento: dopo il ripristino il v0.4.3 riapre le celle com’erano (stesse note, schema 12, verify verde)', async () => {
    const e = await eng()
    const dir = join(ROOT, 'ripristino')
    cpSync(FIXTURE, join(dir, 'memory'), { recursive: true })
    // 1) il motore nuovo apre: la copia nasce, la cella si aggiorna quando si apre, e nel frattempo l'utente scrive
    const st = await e.openMemoryEngine({ dataDir: dir, now: new Date('2026-11-27T10:30:00Z') })
    expect(st.available).toBe(true)
    const copia = join(dir, 'memory-backup-schema12-2026-11-27')
    expect(st.backup?.dir).toBe(copia)
    await (await e.userCell(null)).put({ body: 'nota scritta dopo l’aggiornamento', source: 'homun:user', confidence: 'stated' })
    expect(await leggi(join(dir, 'memory', 'cells', 'utente.sqlite'))).toEqual({ ok: true, schema: ENGINE_SCHEMA })
    await e.closeMemoryEngine()
    // con l'app chiusa: 3) la memoria aggiornata si sposta da parte, 4) la copia torna a essere memory — la copia di sicurezza resta
    renameSync(join(dir, 'memory'), join(dir, 'memory-migrata-2026-11-28'))
    cpSync(copia, join(dir, 'memory'), { recursive: true })
    expect(sha(join(dir, 'memory', 'cells', 'utente.sqlite'))).toBe(GOLDEN_SHA)
    expect(readdirSync(dir).sort()).toEqual(['memory', 'memory-backup-schema12-2026-11-27', 'memory-migrata-2026-11-28'])
    // 5) la versione precedente di Homun: il suo motore è il .node v0.4.3
    process.env.SANDBOT_ENGRAMMA_DIR = V043!
    e.resetEngrammaModuleCacheForTests()
    const st2 = await e.openMemoryEngine({ dataDir: dir })
    expect(st2.available).toBe(true)
    expect(st2.version).toBe('0.1.0-dev')
    expect(st2.backup).toBeUndefined()
    const cell = await e.userCell(null)
    const note = await cell.list({ limit: 10 })
    expect(note.map((n) => n.body).sort()).toEqual(GOLDEN_BODIES)
    expect(note.every((n) => n.status === 'active' && n.version === 1)).toBe(true)
    expect((await (cell as unknown as { verify(): Promise<{ ok: boolean }> }).verify()).ok).toBe(true)
    expect(await leggi(join(dir, 'memory', 'cells', 'utente.sqlite'))).toEqual({ ok: true, schema: 12 })
    // la nota scritta dopo l'aggiornamento non è andata persa: sta nella memoria aggiornata, messa da parte
    expect(readdirSync(join(dir, 'memory-migrata-2026-11-28', 'cells'))).toContain('utente.sqlite')
  })

  it('col .node v0.4.3, che non dice il suo schema, il motore non copia e non aggiorna: le celle restano a 12', async () => {
    const e = await eng()
    const dir = join(ROOT, 'col-vecchio')
    cpSync(FIXTURE, join(dir, 'memory'), { recursive: true })
    process.env.SANDBOT_ENGRAMMA_DIR = V043!
    e.resetEngrammaModuleCacheForTests()
    const st = await e.openMemoryEngine({ dataDir: dir })
    expect(st.available).toBe(true)
    expect(st.backup).toBeUndefined()
    expect(await (await e.userCell(null)).list({ limit: 10 })).toHaveLength(2)
    expect(readdirSync(dir)).toEqual(['memory'])
    expect(await leggi(join(dir, 'memory', 'cells', 'utente.sqlite'))).toEqual({ ok: true, schema: 12 })
  })
})
