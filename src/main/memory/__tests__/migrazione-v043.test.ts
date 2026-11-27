// Fase memoria-engramma v0.6.19 (E2): la migrazione provata su celle vere
// della v0.4.3 — scritte DAL MOTORE VECCHIO con le funzioni di Homun, aperte
// col motore nuovo.
//
// COME. Il .node v0.4.3 (SANDBOT_TEST_ENGRAMMA_V043_DIR: senza, il file
// salta) crea nella cartella di prova le celle come le fa Homun, coi suoi
// actor: memorie del bot e condivise (writeMemoryNote, memorySave),
// riscritture (updateMemoryNote), un cambio di tier e uno di scope, lapidi
// e un ripristino, una purgata, una external in attesa e una confermata, la
// storia (indexStoryNote, anche re-indicizzata), una cella dimenticata
// (dropCellAndEvict) e — se il modello locale c'è, per symlink e senza rete —
// i vettori (embedCellsOfAgent). Poi la FOTOGRAFIA a motore freddo: list,
// get, history e search di ogni cella.
// Il motore SOTTO PROVA è quello del repo (vendor/engramma), oppure quello
// che dice SANDBOT_TEST_ENGRAMMA_NUOVO_DIR: puntato al v0.4.3 gli stessi
// test girano sul motore vecchio e devono essere ROSSI dove c'è una
// differenza vera (lo sono: backup, schema, verify, conflicts(), le copie).
//
// COSA ESCE (visto sul motore v0.6.19-beta.1, schema 24):
// - UGUALE, campo per campo: ogni nota mai riscritta nel corpo (list, get,
//   history; lapidi comprese), gli errori (stesso code; il messaggio ora è
//   in inglese), la ricerca di una cosa precisa (la prima riga è quella di
//   prima, a parte il punteggio) e i vettori di prima, che migrano con le
//   loro note.
// - NON SI CONFRONTA (ranking del motore, cambiato dalla v0.4.5): punteggi,
//   ordine e richiami deboli di una ricerca.
// - DIVERSO, e NON per colpa degli actor di Homun: la migrazione di una
//   cella v0.4.3 fa nascere una copia di conflitto per ogni RISCRITTURA
//   vecchia (patch, re-index della storia). Le operazioni scritte prima
//   della v0.6 non hanno «base» (migrate_log_v15: «base stays NULL») e la
//   derivazione dei conflitti (conflicts.rs, v0.6.4) le tratta tutte come
//   radici concorrenti: ogni corpo precedente diventa una nota «conflitto»
//   (in quarantena se l'ha persa un agente, attiva se l'ha persa l'utente),
//   e se l'utente aveva scritto la nota e il bot l'ha riscritta, il corpo
//   torna quello dell'utente e la riscrittura del bot finisce in quarantena.
//   È un difetto del motore (il commento della migrazione dice «sequential
//   by declaration»): qui lo si tiene con it.fails (ciò che la spec chiede)
//   e con la caratterizzazione di ciò che fa, finché non lo corregge.
//   SUL MOTORE NUOVO, a celle fresche, la mano dell'utente e poi quella del
//   bot sulla stessa nota NON creano nulla: è il test «una sola mano».
// - VETTORI: due note di prima restano senza (il giro le incorpora di novo):
//   una eliminata e ripristinata col motore vecchio, e quella col corpo
//   cambiato dalla migrazione.
// - FUNZIONANO sulle celle migrate: put, purge, dropCell, embedPending (senza
//   modello risponde MODEL_MISSING come prima; col modello incorpora).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'
import { DatabaseSync } from 'node:sqlite'
import { hasLocalEmbedModel, LOCAL_EMBED_MODEL } from '../../../test-local-model'
import type { EngrammaCell, EngrammaNoteView, EngrammaSearchHit, MemoryEngineStatus } from '../engine'
import type { WriteMemoryNoteInput } from '../memory-store'

const REPO = join(import.meta.dirname, '..', '..', '..', '..')
/** Il motore SOTTO PROVA: quello del repo, o quello che dice la variabile (il rosso: il v0.4.3 al posto del nuovo). */
const NUOVO = process.env.SANDBOT_TEST_ENGRAMMA_NUOVO_DIR || join(REPO, 'vendor', 'engramma')
/** La cartella col .node v0.4.3 (index.js accanto): crea le celle di prima. */
const V043 = process.env.SANDBOT_TEST_ENGRAMMA_V043_DIR
const haV043 = !!V043 && existsSync(join(V043, 'index.js')) && existsSync(join(V043, 'engramma.darwin-arm64.node'))
/** Il modello di embedding locale, come i test della corsia: un symlink, niente rete. */
const haModello = hasLocalEmbedModel()
const MODELLO = 'granite-embedding-97m-multilingual-r2'

const eng = () => import('../engine')
const ms = () => import('../memory-store')
const rpc = () => import('../memory-rpc')
const hs = () => import('../history-store')

/** Il tetto dei test che caricano il modello: secondi, non millisecondi. */
const LUNGO = 240_000

const AG = 'agent_e2migraz001'
const AG2 = 'agent_e2dimenticat'
const AG3 = 'agent_e2fresco0001'
const src = (n: number): string => `homun:chat/${AG}/${n}`
const GIORNO = new Date('2026-11-27T10:30:00Z')
const COPIA = 'memory-backup-schema12-2026-11-27'

// ---- il motore che Homun carica: NUOVO o V043, nello stesso processo (come il test del ripristino) ----

const prev = process.env.SANDBOT_ENGRAMMA_DIR
async function usa(dir: string): Promise<void> {
  await (await eng()).closeMemoryEngine()
  process.env.SANDBOT_ENGRAMMA_DIR = dir
  ;(await eng()).resetEngrammaModuleCacheForTests()
}
async function rimettiAmbiente(): Promise<void> {
  await (await eng()).closeMemoryEngine()
  if (prev === undefined) delete process.env.SANDBOT_ENGRAMMA_DIR
  else process.env.SANDBOT_ENGRAMMA_DIR = prev
  ;(await eng()).resetEngrammaModuleCacheForTests()
}

/** Lo schema del motore sotto prova (buildInfo): quello a cui migra. null se non lo dice (il v0.4.3: il rosso). */
const SCHEMA_NUOVO: number | null = await (async () => {
  await usa(NUOVO)
  try {
    const mod = (await (await eng()).engrammaModule())!
    return typeof mod.buildInfo === 'function' ? mod.buildInfo().schema : null
  } finally {
    await rimettiAmbiente()
  }
})()

type CellaNuova = EngrammaCell & {
  conflicts?: () => Array<{ copyId: string; originalId: string; loserActor: string; loserClass: string; quarantined: boolean; visible: boolean }>
  verify?: () => { ok: boolean; mismatch?: string }
}
const cellaNuova = async (name: string): Promise<CellaNuova> => (await (await eng()).memoryCell(name, 'homun:user')) as CellaNuova

/** Le copie di conflitto della cella: [] anche dove il binding non ha conflicts() (il v0.4.3 non le conosce). */
async function conflitti(name: string): Promise<Awaited<ReturnType<NonNullable<CellaNuova['conflicts']>>>> {
  const c = await cellaNuova(name)
  return typeof c.conflicts === 'function' ? c.conflicts() : []
}
/** Le note con il tag «conflitto» (ciò che la migrazione — o una mano concorrente — ha fatto nascere). */
async function copieDi(name: string): Promise<EngrammaNoteView[]> {
  return (await (await eng()).listAll(await cellaNuova(name))).filter((n) => n.tags.includes('conflitto'))
}
const perId = (note: EngrammaNoteView[]): Record<string, EngrammaNoteView> => Object.fromEntries(note.map((n) => [n.id, n]))
/** Tutte le note di una cella, vive e lapidi: senza filtro il motore elenca solo le vive, le lapidi (col corpo, dal v0.4.2) si chiedono a parte. */
async function tutte(cell: EngrammaCell): Promise<EngrammaNoteView[]> {
  const vive = await (await eng()).listAll(cell)
  return vive.some((n) => n.status === 'deleted') ? vive : [...vive, ...(await (await eng()).listAll(cell, { status: ['deleted'] }))]
}

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const nomi = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])
/** Lo schema di una cella letto senza il motore (la cartella di servizio, se serve, resta nella base del test). */
const schemaDi = async (file: string, root: string) => (await import('../cell-backup')).readCellSchema(file, { mkdtemp: (p) => mkdtempSync(join(root, p)) })
/** Gli id delle note che hanno un vettore: letti su una COPIA della cella (file, -wal e -shm) con sqlite nudo — per guardare, mai col motore. */
function conVettore(dataDir: string, cella: string, root: string): Set<string> {
  const file = join(dataDir, 'memory', 'cells', cella + '.sqlite')
  const tmp = mkdtempSync(join(root, 'inspect-'))
  try {
    cpSync(file, join(tmp, 'c.sqlite'))
    for (const suf of ['-wal', '-shm']) if (existsSync(file + suf)) cpSync(file + suf, join(tmp, 'c.sqlite' + suf))
    const db = new DatabaseSync(join(tmp, 'c.sqlite'))
    try {
      return new Set((db.prepare('SELECT note_id FROM note_vectors').all() as Array<{ note_id: string }>).map((r) => r.note_id))
    } finally {
      db.close()
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---- le celle di prima: chi è, com'è stato scritto ----

/** Id delle note, per nome (i valori si riempiono quando il motore vecchio le scrive). */
const IDS: Record<string, string> = {}
/** Mai riscritta nel corpo: una sola scrittura (o solo stato, tier, cella): deve essere uguale in tutto. */
const MAI: Array<{ cella: string; id: string }> = []
/** Riscritta nel corpo: [cella, chi ha perso, testo che la copia si porta]. */
const RISCRITTE: Array<[cella: string, chi: 'bot' | 'utente' | 'storia', testo: string]> = []

type Fotografia = Record<string, { note: EngrammaNoteView[]; get: Record<string, EngrammaNoteView | null>; history: Record<string, { version: number; opId: string; note: EngrammaNoteView }[]>; search: Record<string, EngrammaSearchHit[]> }>
/** Il nome di cella per ogni bersaglio. */
const celleDi = async (): Promise<Record<'bot' | 'utente' | 'storia' | 'bot2', string>> => {
  const e = await eng()
  return { bot: e.botCellName(AG), utente: e.USER_CELL, storia: e.storyCellName(AG), bot2: e.botCellName(AG2) }
}
/** Le ricerche della fotografia: una per cosa che si deve trovare (i richiami deboli cambiano col ranking del motore: non sono un dato delle note). */
const BERSAGLI: Array<[cella: 'bot' | 'utente' | 'storia' | 'bot2', query: string, nota: keyof typeof IDS]> = [
  ['bot', 'risposte brevi', 'w1'],
  ['bot', 'gatto Arturo', 'w2'],
  ['bot', 'reunion di novembre', 'w4'],
  ['bot', 'progetto Alba', 'w5'],
  ['bot', 'tier cambia', 'w6'],
  ['bot', 'ripristinata', 'w8'],
  ['bot', 'mercato chiuso', 'w12'],
  ['utente', 'Torino San Salvario', 'u1'],
  ['utente', 'Riepilogo settimanale', 'u2'],
  ['utente', 'venerdì mattina', 'u3'],
  ['utente', 'Epson XP-3100', 'u4'], // la riscrittura del bot: dopo la migrazione la nota torna al testo dell'utente (il test che fallisce lo dice)
  ['utente', 'diventa condivisa', 'w11b'], // la nota nata dal cambio di cella (stesso corpo di quella vecchia, che è lapide)
  ['storia', 'Ciao puoi ricordarmi', 's1'],
  ['storia', 'ritardo di 20 minuti', 's3'],
  ['bot2', 'lavora di notte', 'a2a']
]
const QUERY = [...new Set(BERSAGLI.map((b) => b[1]))]
/** La fotografia di una cartella dati col motore che c'è: ogni cella (list, get, history) e la ricerca. */
async function scatta(dataDir: string): Promise<Fotografia> {
  const e = await eng()
  const engine = await e.memoryEngine()
  const mode = (await engine.modelStatus()).present ? 'hybrid' : 'text'
  const out: Fotografia = {}
  for (const name of (await engine.cells()).sort()) {
    const cell = await e.memoryCell(name, 'homun:user')
    const note = await tutte(cell)
    const get: Fotografia[string]['get'] = {}
    const history: Fotografia[string]['history'] = {}
    for (const n of note) {
      get[n.id] = await cell.get(n.id)
      history[n.id] = await cell.history(n.id)
    }
    out[name] = { note, get, history, search: {} }
  }
  // cella per cella, con ampio k: il confronto è sul ranking di OGNI cella, non sul taglio delle prime righe fra tre (che con le copie in più cambierebbe)
  for (const [name, foto] of Object.entries(out)) {
    for (const q of QUERY) foto.search[q] = await engine.search([name], { text: q, k: 50, mode, graphHops: 2 })
  }
  return out
}
/** Una riga di ricerca senza i punteggi: il ranking del motore è cambiato dalla v0.4.5 (α 0,7 → 0,5), non è un dato della nota. */
const riga = (h: EngrammaSearchHit) => ({ id: h.id, cell: h.cell, title: h.title, snippet: h.snippet, noteType: h.noteType, tags: h.tags, updatedAt: h.updatedAt, status: h.status, support: h.support ?? null })
const codiceDi = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
    return 'nessun errore'
  } catch (e) {
    return (e as { code?: string }).code ?? 'senza code'
  }
}

describe.skipIf(!haV043)('E2: celle scritte dal .node v0.4.3, aperte col motore nuovo', () => {
  let ROOT = ''
  let DATA = ''
  let DATA_FRESCO = ''
  let FOTOGRAFIA: Fotografia = {}
  let CELLE: string[] = []
  let HASH_PRIMA: Record<string, string> = {}
  let ERR_PRIMA: Record<string, string> = {}
  const nomeCella = (agente: string): string => 'bot-' + agente

  beforeAll(async () => {
    ROOT = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-mem-e2-'))
    DATA = join(ROOT, 'data')
    DATA_FRESCO = join(ROOT, 'fresco')
    mkdirSync(DATA, { recursive: true })
    if (haModello) {
      mkdirSync(join(DATA, 'models'), { recursive: true })
      symlinkSync(LOCAL_EMBED_MODEL, join(DATA, 'models', MODELLO))
    }
    // ---- 1) IL MOTORE VECCHIO scrive le celle come le fa Homun ----
    await usa(V043!)
    const e = await eng()
    const st = await e.openMemoryEngine({ dataDir: DATA })
    expect(st.available).toBe(true)
    expect(st.version).toBe('0.1.0-dev')
    expect(st.backup).toBeUndefined() // non dice il suo schema: non copia e non aggiorna
    const { writeMemoryNote, updateMemoryNote } = await ms()
    const { memoryConfirm, memoryDiscard, memoryDelete, memoryRestore, memoryPurge, memorySave } = await rpc()
    const { indexStoryNote, storyNoteId } = await hs()
    const w = (content: string, n: number, extra: Partial<WriteMemoryNoteInput> = {}) =>
      writeMemoryNote(AG, { content, tier: 'log', source: src(n), ...extra })

    IDS.w1 = (await w('L’utente preferisce le risposte brevi e dirette.', 7, { tier: 'core', userTurn: true })).id
    IDS.w2 = (await w('Ha un gatto che si chiama Arturo e non sopporta il latte.', 9)).id
    IDS.w3 = (await w('Dal sito della città: l’ufficio anagrafe chiude alle 13.', 11, { contaminated: true })).id // external, in attesa
    IDS.w4 = (await w('Dalla mail del 3 marzo: la reunion di novembre è il 12.', 12, { contaminated: true })).id
    await memoryConfirm(AG, IDS.w4) // external confermata
    IDS.w5 = (await w('Il progetto si chiama Alba.', 14)).id
    await updateMemoryNote(AG, { id: IDS.w5, content: 'Il progetto si chiama Alba, fase 2.' }) // RISCRITTA dal bot
    RISCRITTE.push([nomeCella(AG), 'bot', 'Il progetto si chiama Alba.'])
    IDS.w6 = (await w('Solo il tier cambia.', 15)).id
    await updateMemoryNote(AG, { id: IDS.w6, tier: 'core' }) // solo intestazione: nessun corpo riscritto
    IDS.w7 = (await w('Eliminata, da dimenticare per sempre.', 16)).id
    await memoryDelete(AG, IDS.w7) // lapide
    IDS.w8 = (await w('Eliminata e ripristinata.', 17, { userTurn: true })).id
    await memoryDelete(AG, IDS.w8)
    await memoryRestore(AG, IDS.w8)
    IDS.w9 = (await w('Purgata dal motore vecchio:Zanzibar.', 18)).id
    expect(await memoryPurge(AG, IDS.w9)).toMatchObject({ scrubbed: true })
    IDS.w10 = (await w('Dal web: scartata dall’utente.', 19, { contaminated: true })).id
    await memoryDiscard(AG, IDS.w10)
    IDS.w11 = (await w('Cambia cella: diventa condivisa.', 20)).id
    IDS.w11b = (await updateMemoryNote(AG, { id: IDS.w11, scope: 'user' })).id // rinasce nell’altra cella, la vecchia è lapide
    IDS.w12 = (await w('Il mercato è chiuso il lunedì.', 21)).id
    await memorySave(AG, { id: IDS.w12, body: 'Il mercato è chiuso il martedì.', tier: 'log' }) // l’UTENTE riscrive una nota del bot
    RISCRITTE.push([nomeCella(AG), 'bot', 'Il mercato è chiuso il lunedì.'])
    IDS.u1 = (await w('Abita a Torino, zona San Salvario.', 22, { scope: 'user', userTurn: true })).id
    IDS.u2 = (await memorySave(AG, { body: 'Per i report si usa il template «Riepilogo settimanale».', tier: 'core', scope: 'user' })).id
    IDS.u3 = (await memorySave(AG, { body: 'Le riunioni del lunedì si preparano il venerdì pomeriggio.', tier: 'log', scope: 'user' })).id
    await memorySave(AG, { id: IDS.u3, body: 'Le riunioni del lunedì si preparano il venerdì mattina.', tier: 'log', scope: 'user' }) // l’utente corregge la sua
    RISCRITTE.push([e.USER_CELL, 'utente', 'Le riunioni del lunedì si preparano il venerdì pomeriggio.'])
    IDS.u4 = (await memorySave(AG, { body: 'La stampante è la Epson.', tier: 'log', scope: 'user' })).id
    await updateMemoryNote(AG, { id: IDS.u4, content: 'La stampante è la Epson XP-3100.' }) // il BOT riscrive una nota dell’utente
    RISCRITTE.push([e.USER_CELL, 'bot', 'La stampante è la Epson XP-3100.'])
    // la storia: due messaggi, e un entry indicizzato due volte (ogni re-index è una riscrittura)
    const t0 = Date.parse('2026-11-20T10:00:00Z')
    IDS.s1 = storyNoteId(AG, 1, t0)
    IDS.s2 = storyNoteId(AG, 1, t0 + 1)
    IDS.s3 = storyNoteId(AG, 2, t0 + 2)
    await indexStoryNote(AG, 1, 'user', 'Ciao, puoi ricordarmi di prenotare il dentista?', t0)
    await indexStoryNote(AG, 1, 'assistant', 'Certo, te lo ricordo: prenotare il dentista.', t0 + 1)
    await indexStoryNote(AG, 2, 'user', 'Ho letto che il treno delle 8 è in ritardo.', t0 + 2, { tainted: true })
    await indexStoryNote(AG, 2, 'user', 'Ho letto che il treno delle 8 è in ritardo di 20 minuti.', t0 + 2, { tainted: true })
    RISCRITTE.push([e.storyCellName(AG), 'storia', 'Ho letto che il treno delle 8 è in ritardo.'])
    // un secondo bot, la cui cella sarà dimenticata col motore nuovo
    IDS.a2a = (await writeMemoryNote(AG2, { content: 'Il secondo bot lavora di notte.', tier: 'log', source: `homun:chat/${AG2}/1` })).id
    IDS.a2b = (await writeMemoryNote(AG2, { content: 'Il secondo bot ha due note.', tier: 'core', source: `homun:chat/${AG2}/2`, userTurn: true })).id
    // i vettori, col modello locale
    if (haModello) expect(await e.embedCellsOfAgent(AG)).toBeGreaterThan(0)
    await e.closeMemoryEngine()

    // ---- 2) com'è su disco, prima: schema 12, l'hash di ogni cella, gli errori del motore vecchio e la fotografia ----
    const cd = await celleDi()
    CELLE = nomi(join(DATA, 'memory', 'cells')).filter((n) => n.endsWith('.sqlite')).map((n) => n.slice(0, -'.sqlite'.length)).sort()
    expect(CELLE).toEqual(Object.values(cd).sort())
    for (const c of CELLE) expect(await schemaDi(join(DATA, 'memory', 'cells', c + '.sqlite'), ROOT)).toEqual({ ok: true, schema: 12 })
    HASH_PRIMA = Object.fromEntries(CELLE.map((c) => [c, sha(join(DATA, 'memory', 'cells', c + '.sqlite'))]))
    // le mai riscritte nel corpo: list, get e history devono restare uguali in tutto
    for (const [nome, id] of Object.entries(IDS)) {
      if (['w5', 'w12', 'u3', 'u4', 's3', 'w9'].includes(nome)) continue // riscritte (o purgate: non c'è più)
      MAI.push({ cella: nome === 's1' || nome === 's2' ? cd.storia : nome === 'u1' || nome === 'u2' || nome === 'w11b' ? cd.utente : nome === 'a2a' || nome === 'a2b' ? cd.bot2 : cd.bot, id })
    }
    await e.openMemoryEngine({ dataDir: DATA })
    ERR_PRIMA = {
      history: await codiceDi(async () => (await e.botCell(AG)).history('01ARZ3NDEKTSV4RRFFQ69G5FAV')),
      historyMsg: await (await e.botCell(AG)).history('01ARZ3NDEKTSV4RRFFQ69G5FAV').then(() => '', (err: Error) => err.message),
      getSconosciuta: String(await (await e.botCell(AG)).get('01ARZ3NDEKTSV4RRFFQ69G5FAV')),
      getPurgata: String(await (await e.botCell(AG)).get(IDS.w9)),
      embed: await codiceDi(async () => (await e.botCell(AG)).embedPending())
    }
    if (haModello) {
      expect(await e.embedPendingCountOfAgent(AG)).toBe(0)
      const vettori = conVettore(DATA, cd.bot, ROOT)
      expect(vettori.has(IDS.w1)).toBe(true)
      expect(vettori.has(IDS.w8)).toBe(true) // eliminata e ripristinata: col vettore, prima
      expect(vettori.has(IDS.w7)).toBe(false) // una lapide non si incorpora (l'indice la tiene nascosta)
    }
    FOTOGRAFIA = await scatta(DATA)
    await e.closeMemoryEngine()
  }, LUNGO)

  afterAll(async () => {
    await rimettiAmbiente()
    if (ROOT) rmSync(ROOT, { recursive: true, force: true })
  })

  afterEach(async () => {
    await (await eng()).closeMemoryEngine()
  })

  // ---- 3) IL MOTORE NUOVO apre ----

  let ST1: MemoryEngineStatus | undefined
  beforeAll(async () => {
    await usa(NUOVO)
    ST1 = await (await eng()).openMemoryEngine({ dataDir: DATA, now: GIORNO })
  })
  const apri = async () => {
    const st = await (await eng()).openMemoryEngine({ dataDir: DATA, now: GIORNO })
    expect(st.available).toBe(true)
    return st
  }

  it('prima la copia di E1 (le celle v0.4.3 byte per byte), poi ogni cella si apre allo schema del motore nuovo e verify è verde', async () => {
    expect(ST1!.available).toBe(true)
    expect(SCHEMA_NUOVO).toBeGreaterThan(12)
    expect(ST1!.backup).toMatchObject({ dir: join(DATA, COPIA), fromSchema: 12, toSchema: SCHEMA_NUOVO })
    // la copia è lo stato di PRIMA: ogni cella com'era su disco a motore vecchio chiuso
    for (const c of CELLE) expect(sha(join(DATA, COPIA, 'cells', c + '.sqlite'))).toBe(HASH_PRIMA[c])
    expect(nomi(DATA)).toEqual(haModello ? ['memory', COPIA, 'models'] : ['memory', COPIA])
    // ogni cella migra quando si apre; verify (v0.6.11) è verde su tutte
    for (const c of CELLE) {
      const cella = await cellaNuova(c)
      expect(typeof cella.verify, 'il binding ha verify()').toBe('function')
      expect((await cella.verify!()).ok, c).toBe(true)
      expect(await schemaDi(join(DATA, 'memory', 'cells', c + '.sqlite'), ROOT)).toEqual({ ok: true, schema: SCHEMA_NUOVO })
    }
  }, LUNGO)

  it('le note MAI riscritte sono uguali campo per campo: list, get e history dicono la stessa cosa di prima, e manca solo la purgata', async () => {
    await apri()
    const e = await eng()
    for (const { cella, id } of MAI) {
      const cell = await e.memoryCell(cella, 'homun:user')
      expect(await cell.get(id), `get ${id}`).toEqual(FOTOGRAFIA[cella]!.get[id])
      expect(await cell.history(id), `history ${id}`).toEqual(FOTOGRAFIA[cella]!.history[id])
      const prima = perId(FOTOGRAFIA[cella]!.note)[id]
      expect(prima, `la fotografia ha ${id}`).toBeDefined()
      expect((await tutte(cell)).find((n) => n.id === id), `list ${id}`).toEqual(prima)
    }
    // nessuna nota di prima manca dopo
    for (const c of CELLE) {
      const dopo = Object.keys(perId(await tutte(await e.memoryCell(c, 'homun:user'))))
      for (const id of Object.keys(perId(FOTOGRAFIA[c]!.note))) expect(dopo, `${c}: ${id}`).toContain(id)
    }
    // la purgata non c’è più, prima come dopo
    expect(await (await e.botCell(AG)).get(IDS.w9)).toBeNull()
  })

  it('chi cerca una cosa la trova: per ogni nota la ricerca dà la stessa prima riga di prima (stessi campi); una riga forte in più è solo una copia', async () => {
    await apri()
    const dopo = await scatta(DATA)
    const cd = await celleDi()
    // u4 è il caso che la migrazione cambia (il corpo torna all’utente): sta nel test che fallisce, non qui
    for (const [cella, q, nota] of BERSAGLI.filter((b) => b[2] !== 'u4')) {
      const prima = FOTOGRAFIA[cd[cella]]!.search[q]![0]
      expect(prima?.id, `prima: «${q}» trova ${nota}`).toBe(IDS[nota])
      const adesso = dopo[cd[cella]]!.search[q]![0]
      expect(adesso?.id, `dopo: «${q}» trova ${nota}`).toBe(IDS[nota])
      expect(riga(adesso!), q).toEqual(riga(prima!))
    }
    // e una riga FORTE che prima non usciva è solo una copia (attiva: la migrazione l’ha fatta nascere); i richiami deboli cambiano col ranking
    for (const c of CELLE) {
      for (const q of QUERY) {
        for (const h of dopo[c]!.search[q]!.filter((x) => x.score >= 0.5 && !FOTOGRAFIA[c]!.search[q]!.some((p) => p.id === x.id))) {
          expect(h.tags, `${c} «${q}»: riga forte in più`).toContain('conflitto')
        }
      }
    }
  })

  it('gli errori del motore restano gli stessi (history di una nota che non c’è: NOT_FOUND; get: null), col messaggio in inglese (v0.6.19)', async () => {
    await apri()
    const cella = await (await eng()).botCell(AG)
    const SCONOSCIUTA = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    expect(ERR_PRIMA.history).toBe('NOT_FOUND')
    expect(ERR_PRIMA.historyMsg).not.toMatch(/no such note/) // prima era in italiano
    await expect(cella.history(SCONOSCIUTA)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/no such note/) })
    // l’oracolo chiuso: get risponde null per una nota che non c’è e per la purgata dal motore vecchio, prima come dopo
    expect(ERR_PRIMA.getSconosciuta).toBe('null')
    expect(ERR_PRIMA.getPurgata).toBe('null')
    expect(await cella.get(SCONOSCIUTA)).toBeNull()
    expect(await cella.get(IDS.w9)).toBeNull()
  })

  it('i vettori di prima migrano con le loro note: dopo aspettano l’incorporazione solo le copie e due note di prima; una nota nuova si incorpora e la ricerca la trova', async () => {
    await apri()
    const cella = await (await eng()).botCell(AG)
    if (!haModello) {
      // senza modello embedPending risponde MODEL_MISSING, prima come dopo (Homun lo chiama solo col modello)
      await expect(cella.embedPending()).rejects.toMatchObject({ code: 'MODEL_MISSING' })
      expect(ERR_PRIMA.embed).toBe('MODEL_MISSING')
      return
    }
    const e = await eng()
    const celleDiAg = [e.botCellName(AG), e.storyCellName(AG), e.USER_CELL]
    const copie = (await Promise.all(celleDiAg.map(copieDi))).reduce((n, l) => n + l.length, 0)
    // due note di prima restano indietro: w8 (eliminata e ripristinata col motore vecchio) perde il vettore nella migrazione,
    // e u4 cambia corpo (torna al testo dell'utente: il test delle copie lo dice), così il suo non vale più. Le altre ce l'hanno ancora
    const vettori = conVettore(DATA, e.botCellName(AG), ROOT)
    expect(vettori.has(IDS.w1)).toBe(true)
    expect(vettori.has(IDS.w8)).toBe(false)
    expect((await e.listAll(await e.userCell(null))).find((n) => n.id === IDS.u4)!.body).not.toBe(FOTOGRAFIA[e.USER_CELL]!.get[IDS.u4]!.body)
    expect(await e.embedCellsOfAgent(AG)).toBe(copie + 2)
    expect(await e.embedPendingCountOfAgent(AG)).toBe(0)
    // dopo il giro ogni nota viva delle tre celle ha il suo vettore (conVettore legge la cella aperta: file, -wal e -shm)
    for (const c of celleDiAg) {
      const vive = await e.listAll(await e.memoryCell(c, 'homun:user'))
      const con = conVettore(DATA, c, ROOT)
      for (const n of vive) expect(con.has(n.id), `${c}: vettore di ${n.id}`).toBe(true)
    }
    // una nota nuova si incorpora col motore nuovo, e la ricerca ibrida la trova
    const { writeMemoryNote } = await ms()
    const n = await writeMemoryNote(AG, { content: 'Nota scritta dopo la migrazione: il cane si chiama Birba.', tier: 'log', source: src(99) })
    expect(await e.embedCellsOfAgent(AG)).toBe(1)
    const engine = await e.memoryEngine()
    expect((await engine.search([e.botCellName(AG)], { text: 'cane Birba', k: 10, mode: 'hybrid', graphHops: 2 })).map((h) => h.id)).toContain(n.id)
    expect((await engine.search([e.botCellName(AG)], { text: 'cane Birba', k: 10, mode: 'text', graphHops: 2 }))[0]!.id).toBe(n.id)
  }, LUNGO)

  it('una sola mano, nessun conflitto — celle NUOVE, motore nuovo: l’utente scrive e il bot riscrive la stessa nota, conflicts() resta vuoto, nessuna quarantena', async () => {
    await (await eng()).closeMemoryEngine()
    const e = await eng()
    expect((await e.openMemoryEngine({ dataDir: DATA_FRESCO })).backup).toBeUndefined() // niente di vecchio: nessuna copia
    const { memorySave } = await rpc()
    const { updateMemoryNote, writeMemoryNote } = await ms()
    // l’utente (homun:user) scrive nella cella condivisa; il bot (homun:bot-<id>) la riscrive, due volte
    const n1 = (await memorySave(AG3, { body: 'Nota dell’utente: la stampante è la Epson.', tier: 'log', scope: 'user' })).id
    await updateMemoryNote(AG3, { id: n1, content: 'Nota dell’utente: la stampante è la Epson XP-3100.' })
    await updateMemoryNote(AG3, { id: n1, tier: 'core' })
    // e al contrario: il bot scrive, l’utente corregge, il bot riscrive di nuovo
    const n2 = (await writeMemoryNote(AG3, { content: 'Il bot scrive: la riunione è il giovedì.', tier: 'log', source: `homun:chat/${AG3}/1` })).id
    await memorySave(AG3, { id: n2, body: 'L’utente corregge: la riunione è il venerdì.', tier: 'log' })
    await updateMemoryNote(AG3, { id: n2, content: 'Il bot riscrive: la riunione è il venerdì alle 10.' })
    for (const c of [e.botCellName(AG3), e.USER_CELL]) {
      const cella = await cellaNuova(c)
      expect(typeof cella.conflicts, 'il binding ha conflicts() (v0.6.4)').toBe('function')
      expect(await cella.conflicts!(), c).toEqual([])
      expect(await copieDi(c), c).toEqual([])
      expect((await (await e.memoryCell(c, 'homun:user')).list({ status: ['quarantined'] })), c).toEqual([])
    }
    expect((await (await e.userCell(null)).get(n1))!.body).toBe('Nota dell’utente: la stampante è la Epson XP-3100.')
    expect((await (await e.memoryCell(e.botCellName(AG3), 'homun:user')).get(n2))!.body).toBe('Il bot riscrive: la riunione è il venerdì alle 10.')
  })

  it.fails('ciò che la spec chiede e OGGI IL MOTORE NON FA: dalla migrazione nessuna copia di conflitto, le note com’erano', async () => {
    await apri()
    const e = await eng()
    for (const c of CELLE) expect(await conflitti(c), c).toEqual([])
    for (const c of CELLE) expect(Object.keys(perId(await tutte(await e.memoryCell(c, 'homun:user')))).sort(), c).toEqual(Object.keys(perId(FOTOGRAFIA[c]!.note)).sort())
    // la nota dell’utente che il bot aveva riscritto col motore vecchio: resta com’era (la riscrittura del bot)
    expect((await (await e.userCell(null)).list({ limit: 1000 })).find((n) => n.id === IDS.u4)!.body).toBe('La stampante è la Epson XP-3100.')
    const dopo = await scatta(DATA)
    const cd = await celleDi()
    for (const [cella, q, nota] of BERSAGLI) {
      expect(FOTOGRAFIA[cd[cella]]!.search[q]![0]?.id, `prima: «${q}»`).toBe(IDS[nota])
      expect(dopo[cd[cella]]!.search[q]![0]?.id, `dopo: «${q}» trova ${nota}`).toBe(IDS[nota]) // «Epson XP-3100»: dopo la migrazione la trova solo nella copia, in quarantena
    }
  })

  it('CARATTERIZZAZIONE (finché il motore non lo corregge): la migrazione fa nascere una copia per ogni riscrittura vecchia — chi l’ha persa decide lo stato, e la nota dell’utente torna al suo testo', async () => {
    await apri()
    const e = await eng()
    // per ogni riscrittura: una nota «conflitto» col corpo di PRIMA della riscrittura
    const coppe: Record<string, EngrammaNoteView[]> = Object.fromEntries(await Promise.all(CELLE.map(async (c) => [c, await copieDi(c)])))
    const attese: Record<string, EngrammaNoteView[]> = {}
    for (const [cella, chi, testo] of RISCRITTE) {
      const copia = coppe[cella]!.find((n) => n.body === testo)
      expect(copia, `copia con il testo di prima in ${cella}`).toBeDefined()
      // chi l’ha persa è un agente (il bot, la storia): la copia nasce in quarantena; l’utente: attiva e visibile
      expect(copia!.status).toBe(chi === 'utente' ? 'active' : 'quarantined')
      expect(copia!.tags.at(-1)).toBe('conflitto')
      expect(copia!.version).toBe(0)
      ;(attese[cella] ??= []).push(copia!)
    }
    for (const c of CELLE) expect(coppe[c]!.length, c).toBe((attese[c] ?? []).length)
    // conflicts(): una per copia, con chi ha perso
    for (const c of CELLE) {
      const conflittiCella = await conflitti(c)
      expect(conflittiCella.length, c).toBe((attese[c] ?? []).length)
      for (const k of conflittiCella) {
        expect(k.quarantined).toBe(k.loserClass === 'agent')
        expect(k.visible).toBe(true)
      }
    }
    expect((await conflitti(nomeCella(AG))).map((k) => k.loserActor).sort()).toEqual([`homun:bot-${AG}`, `homun:bot-${AG}`])
    expect((await conflitti(e.USER_CELL)).map((k) => [k.loserActor, k.loserClass]).sort()).toEqual([
      [`homun:bot-${AG}`, 'agent'],
      ['homun:user', 'human']
    ])
    expect((await conflitti(e.storyCellName(AG))).map((k) => [k.loserActor, k.loserClass])).toEqual([['homun:story', 'agent']])
    // la nota riscritta dal suo stesso autore resta com’era (il testo nuovo è suo); quella dell’utente riscritta dal bot NO: torna al testo dell’utente
    expect((await (await e.botCell(AG)).get(IDS.w5))!.body).toBe('Il progetto si chiama Alba, fase 2.')
    expect((await (await e.userCell(null)).list({ limit: 1000 })).find((n) => n.id === IDS.u4)!.body).toBe('La stampante è la Epson.')
    // le altre riscritture non hanno fatto nascere nulla
    expect(Object.values(coppe).flat().length).toBe(RISCRITTE.length)
  })

  it('una seconda apertura non rifà il backup (la copia c’è già e le celle sono migrate)', async () => {
    const st = await apri()
    expect(st.backup).toBeUndefined()
    expect(nomi(DATA)).toEqual(haModello ? ['memory', COPIA, 'models'] : ['memory', COPIA])
  })

  it('una sola mano anche sulla cella MIGRATA: l’utente scrive e il bot riscrive la stessa nota — nessun conflitto NUOVO', async () => {
    await apri()
    const e = await eng()
    const prima = Object.fromEntries(await Promise.all(CELLE.map(async (c) => [c, await conflitti(c)])))
    const { memorySave } = await rpc()
    const { updateMemoryNote } = await ms()
    const n = (await memorySave(AG, { body: 'Scritta dall’utente dopo la migrazione.', tier: 'log', scope: 'user' })).id
    await updateMemoryNote(AG, { id: n, content: 'Scritta dall’utente dopo la migrazione, corretta dal bot.' })
    for (const c of CELLE) expect(await conflitti(c), c).toEqual(prima[c])
    expect((await (await e.userCell(null)).get(n))!.body).toBe('Scritta dall’utente dopo la migrazione, corretta dal bot.')
  })

  it('put, purge, dropCell ed embedPending funzionano sulle celle migrate', async () => {
    await apri()
    const e = await eng()
    const { writeMemoryNote } = await ms()
    const { memoryPurge } = await rpc()
    // put
    const n = await writeMemoryNote(AG, { content: 'Scritta col motore nuovo su una cella migrata.', tier: 'core', source: src(31), userTurn: true })
    expect(await (await e.botCell(AG)).get(n.id)).toMatchObject({ body: n.body, confidence: 'stated', tags: ['core'] })
    // purge di una lapide scritta dal v0.4.3: oblio completo, e non si ritrova più
    expect(await memoryPurge(AG, IDS.w7)).toMatchObject({ scrubbed: true, pending: [] })
    expect(await (await e.botCell(AG)).get(IDS.w7)).toBeNull()
    expect(await (await e.botCell(AG)).list({ status: ['deleted'] })).not.toContainEqual(expect.objectContaining({ id: IDS.w7 }))
    // dropCell di una cella scritta dal v0.4.3 e migrata: sparisce dal motore e dal disco
    expect(await e.dropCellAndEvict(nomeCella(AG2), 'agent deleted (M5)')).toMatchObject({ alreadyGone: false, scrubbed: true, pending: [] })
    expect(await (await e.memoryEngine()).cells()).not.toContain(nomeCella(AG2))
    expect(existsSync(join(DATA, 'memory', 'cells', nomeCella(AG2) + '.sqlite'))).toBe(false)
    expect(await e.dropCellAndEvict(nomeCella(AG2), 'agent deleted (M5)')).toMatchObject({ alreadyGone: true })
    // embedPending: senza modello MODEL_MISSING come prima (sopra); col modello la nota nuova si incorpora (sopra)
    for (const c of CELLE.filter((x) => x !== nomeCella(AG2))) expect((await (await cellaNuova(c)).verify!()).ok, c).toBe(true)
  })
})
