// Fase memoria-engramma v0.6.19 (tappa 5): la mano dell'utente.
//
// Col motore v0.6, nei conflitti vince la mano umana: `homun:user` è umano,
// `homun:bot-<id>` e `homun:story` sono agenti (per-homun.md, v0.6.3–0.6.5),
// e «per scrivere da umano, l'UI deve usare homun:user». Ogni azione partita
// da un clic dell'utente sull'interfaccia della memoria — conferma, scarta,
// elimina, ripristina, dimentica, salva — dev'essere firmata da lui nel
// registro del motore, nella cella del bot come in quella condivisa. Prima
// (ownerCell in memory-rpc.ts) le cinque azioni sulla cella del bot passavano
// dalla cella del bot stesso: il registro le scriveva come homun:bot-<id>,
// una mano d'agente. Le azioni del bot (i suoi strumenti) e della storia
// restano come sono.
//
// Il registro è changesSince: le operazioni della cella, con il loro actor.
// history() dà, per ogni versione, l'id dell'operazione che la registra (lo
// stato della nota PRIMA di lei: una nota appena creata non ne ha): per una
// nota riscritta l'ultima versione è l'operazione appena fatta, e se ne legge
// l'actor nel registro. Di una nota dimenticata lo storico non c'è più: resta
// il registro.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'
import type { EngrammaCell, EngrammaOpView } from '../engine'

const ROOT = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-mem-mano-'))
afterAll(async () => {
  const { closeMemoryEngine } = await import('../engine')
  await closeMemoryEngine()
  rmSync(ROOT, { recursive: true, force: true })
})
beforeAll(async () => {
  const { setDataDir } = await import('../../store/db')
  setDataDir(join(ROOT, 'db'))
})

const A = 'agent_mano5'
const UTENTE = 'homun:user'
const BOT = `homun:bot-${A}`
const SCOPI = ['agent', 'user'] as const
type Scope = (typeof SCOPI)[number]

/** Il motore aperto su una cartella nuova (niente rete, niente modello). */
async function fresh() {
  const e = await import('../engine')
  await e.closeMemoryEngine()
  const st = await e.openMemoryEngine({ dataDir: join(ROOT, 'd' + Math.random().toString(36).slice(2, 8)) })
  expect(st.available).toBe(true)
  return e
}

/** La cella di uno scope (bot-<id> o utente), aperta da una mano qualunque: il registro è della cella. */
async function cellaDi(e: Awaited<ReturnType<typeof fresh>>, scope: Scope): Promise<EngrammaCell> {
  return scope === 'user' ? e.userCell(null) : e.botCell(A)
}

/** Le operazioni che una cella ha nel registro da «da» in poi. */
async function registro(cell: EngrammaCell, da = 0): Promise<{ head: number; ops: EngrammaOpView[] }> {
  const log = await cell.changesSince(da)
  if (!('ops' in log)) throw new Error('registro compattato: il test non lo legge')
  return log
}

/**
 * Chi ha firmato l'ultima operazione su una nota, letta due volte: dal
 * registro (changesSince: l'ultima operazione che la porta) e dallo storico
 * (history: l'operazione che registra l'ultima versione, cercata nel registro
 * per il suo id). `stessa` dice che le due vie dicono la stessa operazione:
 * nessuna sfugge a chi legge lo storico.
 */
async function firmataria(cell: EngrammaCell, id: string): Promise<{ registro: string | undefined; storico: string | undefined; stessa: boolean }> {
  const { ops } = await registro(cell)
  const sullaNota = ops.filter((o) => o.noteId === id)
  const ultima = sullaNota.length ? sullaNota[sullaNota.length - 1]! : undefined
  const versions = await cell.history(id)
  const opId = versions.length ? versions[versions.length - 1]!.opId : undefined
  return {
    registro: ultima?.actor,
    storico: ops.find((o) => o.opId === opId)?.actor,
    stessa: opId !== undefined && opId === ultima?.opId
  }
}

/** Una firma letta dal registro e dallo storico. */
const firmata = (actor: string) => ({ registro: actor, storico: actor, stessa: true })

/**
 * Tutto ciò che un'azione dell'utente ha scritto nel registro da «da» in poi
 * è firmato homun:user, e qualcosa ha scritto sulla nota.
 */
async function scrittaDallUtente(cell: EngrammaCell, id: string, da: number): Promise<void> {
  const { ops } = await registro(cell, da)
  expect(ops.length).toBeGreaterThan(0)
  expect(ops.map((o) => o.actor)).toEqual(ops.map(() => UTENTE))
  expect(ops.some((o) => o.noteId === id)).toBe(true)
}

type Stato = 'quarantined' | 'active' | 'deleted'
type Azione = { nome: string; prepara: Stato; rpc: 'memoryConfirm' | 'memoryDiscard' | 'memoryDelete' | 'memoryRestore' | 'memoryPurge'; dopo: Stato | 'assente' }
const AZIONI: Azione[] = [
  { nome: 'conferma', prepara: 'quarantined', rpc: 'memoryConfirm', dopo: 'active' },
  { nome: 'scarta', prepara: 'quarantined', rpc: 'memoryDiscard', dopo: 'deleted' },
  { nome: 'elimina', prepara: 'active', rpc: 'memoryDelete', dopo: 'deleted' },
  { nome: 'ripristina', prepara: 'deleted', rpc: 'memoryRestore', dopo: 'active' },
  { nome: 'dimentica', prepara: 'deleted', rpc: 'memoryPurge', dopo: 'assente' }
]

describe.each<Scope>(SCOPI)('tappa 5: le azioni dell’utente sulla cella %s sono firmate homun:user', (scope) => {
  it.each(AZIONI)('$nome', async ({ prepara, rpc, dopo }) => {
    const e = await fresh()
    const { writeMemoryNote, locateMemoryNote } = await import('../memory-store')
    const rpcMem = await import('../memory-rpc')
    const cell = await cellaDi(e, scope)
    // la nota come la lascia il bot: in attesa (contaminata) o attiva; la lapide la mette l'utente
    const n = await writeMemoryNote(A, {
      content: `Nota da ${prepara} (${scope}).`, tier: 'log', scope, source: 'homun:chat/x/1',
      ...(prepara === 'quarantined' ? { contaminated: true } : { userTurn: true })
    })
    if (prepara === 'deleted') {
      const da = (await registro(cell)).head
      await rpcMem.memoryDelete(A, n.id)
      await scrittaDallUtente(cell, n.id, da)
    }
    expect((await locateMemoryNote(A, n.id))?.state).toBe(prepara)

    const da = (await registro(cell)).head
    await rpcMem[rpc](A, n.id)
    await scrittaDallUtente(cell, n.id, da)
    if (dopo === 'assente') {
      // dimenticata per sempre: non c'è più in nessuno stato
      for (const status of ['active', 'quarantined', 'deleted'] as const) {
        expect((await rpcMem.memoryList(A, { owner: scope === 'user' ? 'user' : 'bot', status, limit: 1000 })).notes.some((x) => x.id === n.id)).toBe(false)
      }
    } else {
      expect((await locateMemoryNote(A, n.id))?.state).toBe(dopo)
      expect(await firmataria(cell, n.id)).toEqual(firmata(UTENTE))
    }
    await e.closeMemoryEngine()
  })

  it('salva: nota nuova e riscritta', async () => {
    const e = await fresh()
    const { locateMemoryNote } = await import('../memory-store')
    const rpc = await import('../memory-rpc')
    const cell = await cellaDi(e, scope)
    // la nota nuova: solo il registro (una nota appena creata non ha storico)
    const da = (await registro(cell)).head
    const n = await rpc.memorySave(A, { body: `Scritta dall’interfaccia (${scope}).`, tier: 'log', scope })
    await scrittaDallUtente(cell, n.id, da)
    expect((await locateMemoryNote(A, n.id))?.state).toBe('active')
    // la riscrittura: registro e storico
    const diNuovo = (await registro(cell)).head
    await rpc.memorySave(A, { id: n.id, body: 'Cambiata dall’interfaccia.', tier: 'core' })
    await scrittaDallUtente(cell, n.id, diNuovo)
    expect(await firmataria(cell, n.id)).toEqual(firmata(UTENTE))
    expect((await locateMemoryNote(A, n.id))?.note?.body).toBe('Cambiata dall’interfaccia.')
    await e.closeMemoryEngine()
  })
})

describe('tappa 5: il bot e la storia restano come sono', () => {
  it('update_memory (write, update, delete) firma homun:bot-<id>, nella sua cella e in quella condivisa', async () => {
    const e = await fresh()
    const { executeTool } = await import('../../agent/tools')
    for (const scope of SCOPI) {
      const cell = await cellaDi(e, scope)
      const da = (await registro(cell)).head
      const w = await executeTool(A, 'update_memory', { action: 'write', content: `Detta dal bot (${scope}).`, tier: 'log', scope }, { userTurn: true, turnEntryId: 5 })
      const short = /id ([0-9A-Z]{8})/.exec(w.output)![1]!
      await executeTool(A, 'update_memory', { action: 'update', id: short, content: `Riscritta dal bot (${scope}).` })
      await executeTool(A, 'update_memory', { action: 'delete', id: short })
      expect((await registro(cell, da)).ops.map((o) => o.actor)).toEqual([BOT, BOT, BOT])
    }
    await e.closeMemoryEngine()
  })

  it('la storia firma homun:story', async () => {
    const e = await fresh()
    const { indexStoryNote, storyNoteId } = await import('../history-store')
    const id = storyNoteId(A, 5, 1730000000000)
    await indexStoryNote(A, 5, 'user', 'una frase della conversazione', 1730000000000)
    const cell = await e.memoryCell(e.storyCellName(A), UTENTE)
    expect((await registro(cell)).ops.filter((o) => o.noteId === id).map((o) => o.actor)).toEqual(['homun:story'])
    await e.closeMemoryEngine()
  })

  it('la lapide messa dall’utente resta una lapide: il bot non la riscrive, non nasce nulla in quarantena', async () => {
    const e = await fresh()
    const { writeMemoryNote, locateMemoryNote } = await import('../memory-store')
    const rpc = await import('../memory-rpc')
    const { executeTool } = await import('../../agent/tools')
    const cell = await e.botCell(A)
    const n = await writeMemoryNote(A, { content: 'Da eliminare.', tier: 'log', source: 'homun:chat/x/1', userTurn: true })
    await rpc.memoryDelete(A, n.id)
    expect(await firmataria(cell, n.id)).toEqual(firmata(UTENTE))
    const z = await executeTool(A, 'update_memory', { action: 'update', id: n.id.slice(-8), content: 'riprovo' })
    expect(z.output).toMatch(/was deleted/i)
    expect(z.meta.error).toBe(true)
    expect((await locateMemoryNote(A, n.id))?.state).toBe('deleted')
    expect(await cell.list({ status: ['quarantined'] })).toHaveLength(0)
    expect(await cell.list({ status: ['active'] })).toHaveLength(0)
    await e.closeMemoryEngine()
  })
})
