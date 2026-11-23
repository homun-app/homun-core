// B4 (fase b20-bug): ARCHIVIA nella Libreria — lo store, la migrazione e le
// RPC, sul daemon vero (buildApiMethods) con lo store vero su una cartella
// temporanea:
//   · migrazione ADDITIVA: a un DB di oggi (library_items SENZA la colonna
//     archived, con dentro una voce) la colonna si aggiunge con ALTER TABLE
//     … ADD COLUMN … DEFAULT 0, la voce vecchia NON è archiviata, niente si
//     perde;
//   · library:archive(id, archived): la voce archiviata sparisce da
//     library:list (la vista normale) e compare SOLO con il filtro
//     «Archiviati» (terzo argomento true); il contenuto resta al suo posto
//     (si legge, i file ci sono, occupa spazio); library:archive(id, false)
//     la ripristina;
//   · validazione: archived deve essere true o false (altro → errore, lo
//     stato non cambia), una voce che non c'è → «voce non trovata»;
//   · anche per il bot (list_library) le archiviate non si elencano; pin,
//     rinomina e delete di una voce archiviata funzionano.
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { TEST_TMP_BASE } from '../../test-tmp'

vi.mock('../../main/agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))
vi.mock('../../main/agent/tools', () => ({
  toolDefs: [],
  executeTool: async () => { throw new Error('non chiamato in questi test') }
}))
vi.mock('../../main/agent/loop', () => ({ interrupt: () => undefined }))
vi.mock('../../main/agent/providers', () => ({
  getProvider: () => undefined,
  modelSupportsTools: async () => ({ ok: true, checked: true })
}))

const { setDataDir, dataDir, db, setSetting } = await import('../../main/store/db')
const storeLibrary = await import('../../main/store/library')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { SandbotEvent, LibraryItemInfo } from '../../shared/types'

const DB_SRC = readFileSync(fileURLToPath(new URL('../../main/store/db.ts', import.meta.url)), 'utf8')
const STORE_SRC = readFileSync(fileURLToPath(new URL('../../main/store/library.ts', import.meta.url)), 'utf8')

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
let api: Record<string, (p: unknown[]) => unknown>

let dir: string
const OLD_ID = 'lib_vecchio'
const AGENT = 'agent_b4'
/** La tabella library_items com'era PRIMA del B4 (senza la colonna archived). */
const LIBRARY_DDL_OLD = `
  CREATE TABLE library_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    author_agent_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    pinned INTEGER DEFAULT 0,
    tainted INTEGER DEFAULT 0,
    current_version INTEGER DEFAULT 1,
    chart_kind TEXT,
    file_name TEXT,
    file_sha256 TEXT,
    file_size INTEGER,
    file_mime TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_library_updated ON library_items(updated_at DESC);`

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-library-archive-'))
})
beforeEach(() => { events = [] })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const call = async (ch: string, ...p: unknown[]): Promise<unknown> => {
  const fn = api[ch]
  if (!fn) throw new Error(`RPC assente nel daemon: ${ch}`)
  return fn(p)
}
const errText = async (fn: () => unknown): Promise<string | null> => {
  try { await fn(); return null } catch (e) { return e instanceof Error ? e.message : String(e) }
}
const listIds = async (...p: unknown[]): Promise<string[]> => ((await call('library:list', ...p)) as LibraryItemInfo[]).map((i) => i.id)
const listOf = async (...p: unknown[]): Promise<LibraryItemInfo[]> => (await call('library:list', ...p)) as LibraryItemInfo[]
// il modulo dell'agente (writeDocument, listLibrary…): nessun db() all'import, si apre alla prima chiamata
const agentLib = await import('../../main/agent/library')
/** Un documento nuovo nello store (la strada del bot, senza modello). */
const doc = (title: string, content = `# ${title}\n\ntesto`): string => {
  const r = agentLib.writeDocument(AGENT, { title, content })
  if (!r.ok) throw new Error(r.error)
  return r.value.id
}
/** Ogni test riparte dalla libreria pulita (resta solo la voce vecchia della migrazione): gli archiviati di un test non finiscono in quello dopo. */
const onlyOld = (): void => {
  for (const i of storeLibrary.allLibraryItems()) if (i.id !== OLD_ID) storeLibrary.deleteLibraryItem(i.id)
}

describe('B4: migrazione ADDITIVA della colonna archived', () => {
  it('un DB di oggi (senza archived) si apre, la colonna si aggiunge in CODA e la voce vecchia NON è archiviata', () => {
    // il database com'era prima del B4, con dentro una voce (fissata, v2)
    const old = new DatabaseSync(join(dir, 'sandbot.db'))
    old.exec(LIBRARY_DDL_OLD)
    old.prepare('INSERT INTO library_items(id, kind, title, author_agent_id, created_at, updated_at, pinned, tainted, current_version) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(OLD_ID, 'document', 'Documento vecchio', AGENT, 1, 2, 1, 0, 2)
    old.close()
    // la PRIMA open() del processo trova la tabella vecchia e la migra (ALTER)
    setDataDir(dir)
    dataDir()
    setSetting('ui.activeLanguage', 'it')
    api = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)
    const cols = (db().prepare("SELECT name FROM pragma_table_info('library_items')").all() as Array<{ name: string }>).map((c) => c.name)
    // le colonne di oggi, nell'ordine di oggi, e la nuova in coda
    expect(cols).toEqual([
      'id', 'kind', 'title', 'author_agent_id', 'created_at', 'updated_at', 'pinned', 'tainted',
      'current_version', 'chart_kind', 'file_name', 'file_sha256', 'file_size', 'file_mime', 'archived'
    ])
    // la riga di prima della migrazione resta leggibile, coi suoi valori, e NON è archiviata
    expect(storeLibrary.getLibraryItem(OLD_ID)).toMatchObject({
      id: OLD_ID, kind: 'document', title: 'Documento vecchio', authorAgentId: AGENT, pinned: true, currentVersion: 2, archived: false
    })
    // il default della colonna è 0: una riga scritta a mano senza il campo non è archiviata
    const dfl = (db().prepare("SELECT dflt_value FROM pragma_table_info('library_items') WHERE name = 'archived'").get() as { dflt_value: string | null })
    expect(dfl.dflt_value).toBe('0')
  })

  it('la forma della migrazione: SOLO «ALTER TABLE library_items ADD COLUMN archived INTEGER DEFAULT 0», protetta dal «se manca» di sempre', () => {
    // la protezione: si guarda pragma_table_info('library_items') e si esegue l'ALTER solo se la colonna manca
    expect(DB_SRC).toMatch(/SELECT name FROM pragma_table_info\('library_items'\)/)
    const guard = /if \(!(\w+)\.(some|has)\(\(c\) => c\.name === 'archived'\)\) db\.exec\('ALTER TABLE library_items ADD COLUMN archived INTEGER DEFAULT 0'\)/.exec(DB_SRC)
    expect(guard, 'manca l\'ALTER protetto da pragma_table_info in db.ts').not.toBeNull()
    // l'unico ALTER della tabella è quello: mai DROP, RENAME o una ricreazione
    expect(DB_SRC.match(/ALTER TABLE library_items[^'"]*/g)).toEqual(['ALTER TABLE library_items ADD COLUMN archived INTEGER DEFAULT 0'])
    for (const src of [DB_SRC, STORE_SRC]) {
      expect(src).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX)\s+(IF EXISTS\s+)?library/i)
      expect(src).not.toMatch(/RENAME\s+(TABLE|COLUMN)\s+library/i)
      expect(src).not.toMatch(/PRAGMA\s+writable_schema/)
    }
    // anche la DDL di un DB NUOVO porta la colonna (CREATE TABLE IF NOT EXISTS non la aggiunge)
    expect(STORE_SRC).toMatch(/file_mime TEXT,\s*archived INTEGER DEFAULT 0\s*\)/)
  })
})

describe('B4: library:archive — la voce archiviata sparisce dalla vista normale e resta nel filtro «Archiviati»', () => {
  let id: string
  beforeEach(() => { onlyOld(); id = doc('Ricettario') })

  it('la RPC esiste e risponde { ok: true }; la colonna si legge dallo store', async () => {
    expect(typeof api['library:archive']).toBe('function')
    expect(storeLibrary.getLibraryItem(id)?.archived).toBe(false)
    expect(await call('library:archive', id, true)).toEqual({ ok: true })
    expect(storeLibrary.getLibraryItem(id)?.archived).toBe(true)
  })

  it('archivia: fuori da library:list (la vista normale), dentro con il filtro «Archiviati» (archived: true)', async () => {
    expect(await listIds()).toContain(id)
    expect((await listOf()).find((i) => i.id === id)?.archived).toBe(false)
    await call('library:archive', id, true)
    expect(await listIds()).not.toContain(id)
    const arch = await listOf(undefined, undefined, true)
    expect(arch.map((i) => i.id)).toContain(id)
    expect(arch.find((i) => i.id === id)?.archived).toBe(true)
    // con la ricerca e col filtro tipo vale la stessa cosa
    expect(await listIds('ricettario')).not.toContain(id)
    expect(await listIds('ricettario', undefined, true)).toEqual([id])
    expect(await listIds(undefined, 'document', true)).toContain(id)
    expect(await listIds(undefined, 'chart', true)).not.toContain(id)
  })

  it('archiviare NON cancella niente: il contenuto si legge, i file restano, lo spazio conta ancora', async () => {
    const bytesBefore = (await call('library:stats')) as { bytes: number }
    await call('library:archive', id, true)
    // si legge come prima (library:get non guarda l'archivio)
    const got = (await call('library:get', id)) as { content: string; versions: number[] }
    expect(got.content).toBe('# Ricettario\n\ntesto')
    expect(got.versions).toEqual([1])
    expect(existsSync(join(dataDir(), 'library', id, 'v1.md'))).toBe(true)
    // l'avviso di spazio (2 GB) continua a contare anche l'archiviato: occupa disco
    const bytesAfter = (await call('library:stats')) as { bytes: number }
    expect(bytesAfter.bytes).toBe(bytesBefore.bytes)
    expect(bytesAfter.bytes).toBeGreaterThan(0)
  })

  it('ripristina: library:archive(id, false) la riporta nella vista normale, fuori dagli archiviati', async () => {
    await call('library:archive', id, true)
    expect(await call('library:archive', id, false)).toEqual({ ok: true })
    expect(await listIds()).toContain(id)
    expect(await listIds(undefined, undefined, true)).not.toContain(id)
    expect((await listOf()).find((i) => i.id === id)?.archived).toBe(false)
    expect(storeLibrary.getLibraryItem(id)?.archived).toBe(false)
  })

  it('archiviare NON cambia updatedAt (al ripristino la voce torna dove era) né il pin', async () => {
    storeLibrary.updateLibraryItem(id, { pinned: true })
    const before = storeLibrary.getLibraryItem(id)!
    await call('library:archive', id, true)
    const during = storeLibrary.getLibraryItem(id)!
    expect(during.updatedAt).toBe(before.updatedAt)
    expect(during.pinned).toBe(true)
    expect(during.title).toBe(before.title)
    expect(during.currentVersion).toBe(before.currentVersion)
  })

  it('la voce di prima della migrazione si archivia e si ripristina come le altre', async () => {
    expect(await listIds()).toContain(OLD_ID)
    await call('library:archive', OLD_ID, true)
    expect(await listIds()).not.toContain(OLD_ID)
    expect(await listIds(undefined, undefined, true)).toEqual([OLD_ID])
    await call('library:archive', OLD_ID, false)
    expect(await listIds()).toContain(OLD_ID)
  })
})

describe('B4: library:archive — validazione dell\'input', () => {
  let id: string
  beforeEach(() => { onlyOld(); id = doc('Da non toccare') })

  it('archived deve essere true o false: qualunque altro valore → errore chiaro e lo stato NON cambia', async () => {
    for (const bad of ['true', 'false', 1, 0, null, undefined, {}, [], 'all']) {
      expect(await errText(() => call('library:archive', id, bad)), `archived=${JSON.stringify(bad)}`)
        .toBe('archived non valido: serve true o false')
    }
    expect(storeLibrary.getLibraryItem(id)?.archived).toBe(false)
    await call('library:archive', id, true)
    for (const bad of ['false', 0, null, undefined]) {
      expect(await errText(() => call('library:archive', id, bad))).toBe('archived non valido: serve true o false')
    }
    // un valore sbagliato non ha ripristinato niente
    expect(storeLibrary.getLibraryItem(id)?.archived).toBe(true)
    // l'errore segue la lingua dell\'interfaccia
    setSetting('ui.activeLanguage', 'en')
    expect(await errText(() => call('library:archive', id, 'si'))).toBe('Invalid archived value: expected true or false')
    setSetting('ui.activeLanguage', 'it')
  })

  it('una voce che non c\'è → «voce non trovata» (anche a argomenti invertiti o vuoti); e resta { ok: true } con l\'id giusto', async () => {
    expect(await errText(() => call('library:archive', 'lib_manca', true))).toBe('voce non trovata')
    expect(await errText(() => call('library:archive', 'lib_manca', false))).toBe('voce non trovata')
    // [true, id]: l'id finisce al posto del flag → non è un booleano
    expect(await errText(() => call('library:archive', true, id))).toBe('archived non valido: serve true o false')
    // senza id
    expect(await errText(() => call('library:archive', undefined, true))).toBe('voce non trovata')
    expect(await errText(() => call('library:archive'))).toBe('archived non valido: serve true o false')
    expect(await errText(() => call('library:archive', '', true))).toBe('voce non trovata')
    expect(await call('library:archive', id, true)).toEqual({ ok: true })
  })
})

describe('B4: library:list — il terzo argomento', () => {
  beforeEach(onlyOld)
  it('di default esclude le archiviate; true → solo loro; \'all\' → tutte; un valore spurio vale come default', async () => {
    const a = doc('Attiva')
    const z = doc('Archiviata')
    await call('library:archive', z, true)
    await call('library:archive', OLD_ID, true)
    const normal = await listIds()
    expect(normal).toContain(a)
    expect(normal).not.toContain(z)
    const both = await listIds(undefined, undefined, 'all')
    expect(both).toEqual(expect.arrayContaining([a, z, OLD_ID]))
    for (const spurio of [false, 'true', 1, 'yes']) {
      const ids = await listIds(undefined, undefined, spurio)
      expect(ids, `archived=${JSON.stringify(spurio)}`).toContain(a)
      expect(ids, `archived=${JSON.stringify(spurio)}`).not.toContain(z)
    }
  })

  it('ogni voce porta il campo archived (booleano)', async () => {
    const a = doc('Attiva due')
    const z = doc('Archiviata due')
    await call('library:archive', z, true)
    const all = [...(await listOf()), ...(await listOf(undefined, undefined, true))]
    for (const i of all) expect(typeof i.archived, i.id).toBe('boolean')
    expect(all.find((i) => i.id === a)?.archived).toBe(false)
    expect(all.find((i) => i.id === z)?.archived).toBe(true)
  })
})

describe('B4: anche per il bot (list_library) e per le altre RPC', () => {
  beforeEach(onlyOld)
  it('list_library non elenca le archiviate: il bot le legge solo se conosce l\'id', async () => {
    const z = doc('Segreta')
    await call('library:archive', z, true)
    expect(agentLib.listLibrary({}).rows.some((r) => r.id === z)).toBe(false)
    expect(agentLib.listLibrary({ query: 'Segreta' }).rows.some((r) => r.id === z)).toBe(false)
    // la lettura diretta (un link lib_… dentro un altro documento) funziona ancora
    const read = agentLib.readDocument({ id: z })
    expect(read.ok && read.value.content).toContain('Segreta')
    // lo store, esplicitamente: normale / solo archiviate / tutte
    expect(storeLibrary.listLibraryItems().some((i) => i.id === z)).toBe(false)
    expect(storeLibrary.listLibraryItems({ archived: true }).map((i) => i.id)).toContain(z)
    expect(storeLibrary.allLibraryItems().some((i) => i.id === z)).toBe(true)
  })

  it('pin e rinomina di una voce archiviata la lasciano archiviata; delete di una voce archiviata la toglie (con la cartella)', async () => {
    const z = doc('Archiviata da sistemare')
    await call('library:archive', z, true)
    expect(await call('library:pin', z, true)).toEqual({ ok: true })
    expect(await call('library:rename', z, 'Rinominata')).toEqual({ ok: true })
    expect(storeLibrary.getLibraryItem(z)).toMatchObject({ archived: true, pinned: true, title: 'Rinominata' })
    expect(await listIds(undefined, undefined, true)).toContain(z)
    expect(existsSync(join(dataDir(), 'library', z))).toBe(true)
    await call('library:delete', z)
    expect(storeLibrary.getLibraryItem(z)).toBeNull()
    expect(existsSync(join(dataDir(), 'library', z))).toBe(false)
    expect(await listIds(undefined, undefined, true)).not.toContain(z)
  })

  it('una nuova voce nasce NON archiviata (documenti, grafici)', async () => {
    const d = agentLib.writeDocument(AGENT, { title: 'Nuova', content: 'x' })
    expect(d.ok && storeLibrary.getLibraryItem(d.value.id)?.archived).toBe(false)
    const c = await agentLib.saveChart(AGENT, { title: 'Grafico', kind: 'mermaid', spec: 'graph TD; A-->B' })
    expect(c.ok).toBe(true)
    if (c.ok) {
      expect(storeLibrary.getLibraryItem(c.value.id)).toMatchObject({ kind: 'chart', archived: false })
      expect((await listOf()).find((i) => i.id === c.value.id)?.archived).toBe(false)
    }
  })
})
