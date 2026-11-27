// Fase memoria-engramma (M6): le RPC memory:* del demone — l'interfaccia
// della sezione Memoria sul motore Engramma. Il contenuto delle note non va
// mai nei log: gli errori portano solo codici e id.
//
//   elenco   per bot e condiviso, filtri core/log e stato (attive, in attesa
//            di conferma) — le lapidi non si elencano (si ripristinano dal
//            dettaglio, che le legge dallo storico);
//   ricerca  lo stesso motore del bot (recall_memory), con explain opzionale;
//   dettaglio la nota, la fonte (link alla conversazione), l'affidabilità,
//            le date di validità e lo storico delle versioni;
//   conferma / scarta     la quarantena (confirm / delete);
//   elimina  lapide reversibile;  ripristino dallo storico (setStatus);
//   dimentica per sempre  purge: l'esito dice se qualcosa trattiene ancora
//            byte (pending) e quale vista non è stata raggiunta;
//   modello  stato e download SOLO dal click dell'utente (pullModel),
//            con l'avanzamento all'interfaccia (evento memory model-pull);
//   errori   fase v0.6.19 (E3): un errore del motore non arriva mai all'utente
//            col suo messaggio inglese. Ogni RPC memory:* e l'esito del
//            download passano dal code dell'errore a una frase del catalogo
//            UI, nella lingua dell'interfaccia (errorePerLaUi,
//            modelPullErrorText); al modello resta l'inglese (memory-store.ts).
import type {
  EngrammaNoteView, EngrammaSearchHit, EngrammaCell, EngrammaListFilter
} from './engine'
import { botCell, userCell, memoryEngineStatus, botCellName, USER_CELL, listAll } from './engine'
import { locateMemoryNote, writeMemoryNote, updateMemoryNote, MemoryNoteError } from './memory-store'
import { MemoryUnavailableError, engineCodeOf } from './engine'
import { uiText } from '../ui-language'
import { UI } from '../../shared/ui-messages'
import type { UiMessage } from '../../shared/ui-messages'
import type {
  MemoryNoteInfo, MemoryNoteDetail, MemorySearchHitInfo, MemoryOverview, MemoryPurgeResult
} from '../../shared/types'

/** La fonte della conversazione di una nota: homun:chat/<bot>/<entry>. */
function chatSourceOf(source: string): { agentId: string | null; entryId: number | null } {
  const m = /^homun:chat\/([^/]+)\/(\d+)$/.exec(source)
  return m ? { agentId: m[1]!, entryId: Number(m[2]) } : { agentId: null, entryId: null }
}

/** Una nota del motore come la vede la UI (owner = bot | user). */
function toNoteInfo(n: EngrammaNoteView, owner: 'bot' | 'user'): MemoryNoteInfo {
  const chat = chatSourceOf(n.source)
  return {
    id: n.id,
    shortId: n.id.slice(-8),
    owner,
    agentId: chat.agentId,
    entryId: chat.entryId,
    body: n.body,
    tier: n.tags.includes('core') ? 'core' : 'log',
    confidence: n.confidence,
    status: n.status,
    source: n.source,
    validFrom: n.validFrom ?? null,
    validTo: n.validTo ?? null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    version: n.version
  }
}

/** Le due celle visibili a un bot: la sua e la condivisa. */
async function ownerCell(agentId: string, owner: 'bot' | 'user'): Promise<EngrammaCell> {
  return owner === 'user' ? userCell(null) : botCell(agentId)
}

// ---- E3: gli errori del motore, detti all'interfaccia ----

/** Dal e.code del motore alla frase: per i code che l'utente può incontrare quella giusta, per gli altri quella generica (mai il messaggio). */
const DAL_CODE: Record<string, UiMessage> = {
  NOT_FOUND: UI.memoryErrorNotFound,
  INVALID_NOTE: UI.memoryErrorInvalid,
  QUARANTINED: UI.memoryErrorAlreadyActive,
  NOTE_PURGED: UI.memoryErrorPurged,
  CLOSED: UI.memoryErrorClosed,
  IO: UI.memoryErrorIo,
  SCHEMA_TOO_NEW: UI.memorySchemaTooNew,
  MODEL_MISSING: UI.memoryErrorModelMissing
}
/** Gli errori di Homun per la memoria (MemoryNoteError): prima il caso (reason), poi il code. */
const DAL_CASO: Record<NonNullable<MemoryNoteError['reason']>, UiMessage> = {
  deleted: UI.memoryErrorDeleted,
  pending: UI.memoryErrorPending,
  empty: UI.memoryErrorEmpty,
  'not-pending': UI.memoryErrorNotPending
}
const DAL_CODE_DI_HOMUN: Record<MemoryNoteError['code'], UiMessage> = {
  NOT_FOUND: UI.memoryErrorNotFound,
  CONFLICT: UI.memoryErrorDeleted,
  INVALID: UI.memoryErrorInvalid
}
/** Il motore non c'è: dal motivo (l'avviso in cima alla sezione dice il perché). */
const DAL_MOTIVO: Record<MemoryUnavailableError['reason'], UiMessage> = {
  'schema-too-new': UI.memorySchemaTooNew,
  closed: UI.memoryErrorClosed,
  module: UI.memoryErrorUnavailable,
  open: UI.memoryErrorUnavailable,
  space: UI.memoryErrorUnavailable
}

/**
 * Un errore diventato frase per l'interfaccia, nella sua lingua: dal code
 * del motore, dal code e dal caso degli errori di Homun, dal motivo per cui
 * il motore non c'è. Un errore senza un code riconosciuto (uno imprevisto)
 * dà la frase generica: un testo che non è del catalogo non parte mai.
 */
function errorePerLaUi(e: unknown): Error {
  let frase: UiMessage | undefined
  if (e instanceof MemoryUnavailableError) frase = DAL_MOTIVO[e.reason]
  else if (e instanceof MemoryNoteError) frase = (e.reason && DAL_CASO[e.reason]) || DAL_CODE_DI_HOMUN[e.code]
  else {
    const code = engineCodeOf(e)
    if (code) frase = DAL_CODE[code] ?? UI.memoryErrorGeneric
  }
  return new Error(uiText(frase ?? UI.memoryErrorGeneric))
}

/** Il testo dell'errore per l'interfaccia (frase del catalogo UI, nella lingua dell'interfaccia). */
export function memoryErrorText(e: unknown): string {
  return errorePerLaUi(e).message
}

/** Il download del modello non riuscito: la frase completa «Download non riuscito: » (MemoryPanel). */
export function modelPullErrorText(e: unknown): string {
  if (e instanceof MemoryUnavailableError || engineCodeOf(e) === 'CLOSED') return uiText(UI.memoryPullFailedUnavailable)
  return uiText(engineCodeOf(e) === 'IO' ? UI.memoryPullFailedIo : UI.memoryPullFailed)
}

/**
 * Le vie dell'interfaccia: ogni RPC memory:* esce da qui, e un errore che
 * la fa fallire arriva alla UI come frase del catalogo (errorePerLaUi). Il
 * confine RPC (ws-server) manda e.message così com'è: qui il messaggio È la
 * frase.
 */
function perLaUi<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args)
    } catch (e) {
      throw errorePerLaUi(e)
    }
  }
}

/**
 * L'elenco con i filtri. Correzioni C4: anche «eliminate» — le lapidi si
 * elencano (v0.4.2, col corpo) così l'utente le ripristina o le dimentica
 * per sempre; senza filtro di stato restano le note VIVE (attive e in attesa
 * di conferma).
 */
export const memoryList = perLaUi(async function memoryList(agentId: string, opts: { owner?: 'bot' | 'user'; tier?: 'core' | 'log'; status?: 'active' | 'quarantined' | 'deleted'; limit?: number; offset?: number } = {}): Promise<{ notes: MemoryNoteInfo[]; more: boolean }> {
  const owner = opts.owner === 'user' ? 'user' : 'bot'
  const cell = await ownerCell(agentId, owner)
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
  const offset = Math.max(opts.offset ?? 0, 0)
  // senza filtro di stato: tutte le note vive (attive e in attesa di conferma)
  const filter: EngrammaListFilter = {
    status: opts.status ? [opts.status] : ['active', 'quarantined'],
    // correzioni C5: la pagina la fa il MOTORE (limit+offset), non slice in
    // JS; una riga in più dice se c'è dell'altro
    limit: limit + 1,
    offset
  }
  if (opts.tier) filter.tags = [opts.tier]
  const page = await cell.list(filter)
  const more = page.length > limit
  return { notes: page.slice(0, limit).map((n) => toNoteInfo(n, owner)), more }
})

/** Il dettaglio: la nota (o la lapide) e lo storico delle versioni. */
export const memoryNote = perLaUi(async function memoryNote(agentId: string, id: string): Promise<MemoryNoteDetail> {
  const found = await locateMemoryNote(agentId, id)
  if (!found) throw new MemoryNoteError(`Memory "${id}" not found.`, 'NOT_FOUND')
  const cell = await ownerCell(agentId, found.scope === 'user' ? 'user' : 'bot')
  const versions = await cell.history(found.id)
  return {
    state: found.state,
    note: found.note ? toNoteInfo(found.note, found.scope === 'user' ? 'user' : 'bot') : null,
    history: versions.map((v) => ({ version: v.version, note: toNoteInfo(v.note, found.scope === 'user' ? 'user' : 'bot') }))
  }
})

/** La ricerca della sezione Memoria: lo stesso motore del bot. */
export const memorySearch = perLaUi(async function memorySearch(agentId: string, query: string, opts: { explain?: boolean } = {}): Promise<MemorySearchHitInfo[]> {
  const { memoryEngine, ensureSearchCells } = await import('./engine')
  await ensureSearchCells(agentId)
  const engine = await memoryEngine()
  const model = await engine.modelStatus()
  const hits: EngrammaSearchHit[] = await engine.search([botCellName(agentId), USER_CELL], {
    text: query, k: 20, mode: model.present ? 'hybrid' : 'text', graphHops: 2,
    ...(opts.explain ? { explain: true } : {})
  })
  return hits.map((h) => ({
    id: h.id,
    shortId: h.id.slice(-8),
    owner: (h.cell === USER_CELL ? 'user' : 'bot') as 'bot' | 'user',
    body: h.snippet,
    tier: h.tags.includes('core') ? 'core' : 'log',
    score: h.score,
    support: h.support ?? null,
    updatedAt: h.updatedAt,
    ...(h.explain ? { explain: h.explain as MemorySearchHitInfo['explain'] } : {})
  }))
})

/** Lo stato per l'interfaccia: motore, modello, conteggi, indicizzazione. */
export async function memoryOverview(agentId: string, getSetting: <T>(key: string, dflt: T) => T): Promise<MemoryOverview> {
  const status = await memoryEngineStatus()
  let counts = { own: 0, shared: 0, pending: 0, deleted: 0 }
  if (status.available) {
    try {
      // own/shared = le note vive (attive e in attesa); pending = quelle in
      // attesa di conferma nelle due celle (la sezione le mette in evidenza);
      // deleted = le lapidi (correzioni C4: si vedono e si dimenticano)
      const bot = await botCell(agentId)
      const user = await userCell(null)
      // correzioni C5: i conteggi a pagine (listAll) — contano TUTTE le note
      const [own, shared, botDead, userDead] = await Promise.all([
        listAll(bot, { status: ['active', 'quarantined'] }),
        listAll(user, { status: ['active', 'quarantined'] }),
        listAll(bot, { status: ['deleted'] }),
        listAll(user, { status: ['deleted'] })
      ])
      const pending = [...own, ...shared].filter((n) => n.status === 'quarantined').length
      counts = { own: own.length, shared: shared.length, pending, deleted: botDead.length + userDead.length }
    } catch {
      // motore chiuso durante il conteggio: zeri
    }
  }
  return {
    engine: {
      available: status.available,
      ...(status.reason ? { reason: status.reason } : {}),
      // E1: col motivo 'space' quanti byte mancano per la copia delle celle (l'interfaccia dice quanti GB liberare)
      ...(status.neededBytes !== undefined ? { neededBytes: status.neededBytes } : {}),
      ...(status.error ? { error: status.error } : {}),
      ...(status.version ? { version: status.version } : {})
    },
    model: { ...status.model, pulling: modelPullState.inFlight },
    counts,
    storyIndexed: !!getSetting<number | null>('memory.storyBackfilledAt', null)
  }
}

/** Conferma: la quarantena diventa attiva (l'utente l'ha vista). */
export const memoryConfirm = perLaUi(async function memoryConfirm(agentId: string, id: string): Promise<void> {
  const found = await locateMemoryNote(agentId, id)
  if (!found) throw new MemoryNoteError(`Memory "${id}" not found.`, 'NOT_FOUND')
  if (found.state !== 'quarantined') return
  await (await ownerCell(agentId, found.scope === 'user' ? 'user' : 'bot')).confirm(found.id)
})

/** Scarta: la quarantena si elimina (lapide). */
export const memoryDiscard = perLaUi(async function memoryDiscard(agentId: string, id: string): Promise<void> {
  const found = await locateMemoryNote(agentId, id)
  if (!found || found.state === 'deleted') return
  if (found.state !== 'quarantined') throw new MemoryNoteError(`Memory "${id}" is not pending confirmation.`, 'INVALID', 'not-pending')
  await (await ownerCell(agentId, found.scope === 'user' ? 'user' : 'bot')).delete(found.id)
})

/** Elimina: lapide reversibile. */
export const memoryDelete = perLaUi(async function memoryDelete(agentId: string, id: string): Promise<void> {
  const found = await locateMemoryNote(agentId, id)
  if (!found || found.state === 'deleted') return
  await (await ownerCell(agentId, found.scope === 'user' ? 'user' : 'bot')).delete(found.id)
})

/** Ripristino dallo storico: la lapide torna attiva. */
export const memoryRestore = perLaUi(async function memoryRestore(agentId: string, id: string): Promise<void> {
  const found = await locateMemoryNote(agentId, id)
  if (!found) throw new MemoryNoteError(`Memory "${id}" not found.`, 'NOT_FOUND')
  if (found.state !== 'deleted') return
  await (await ownerCell(agentId, found.scope === 'user' ? 'user' : 'bot')).setStatus(found.id, 'active')
})

/**
 * Dimentica per sempre: purge. L'esito dice se l'oblio è completo — qualcosa
 * può trattenere ancora byte (pending: il WAL, una vista): il demone lo
 * finisce alla scrittura successiva, e l'interfaccia lo mostra.
 */
export const memoryPurge = perLaUi(async function memoryPurge(agentId: string, id: string): Promise<MemoryPurgeResult> {
  const found = await locateMemoryNote(agentId, id)
  if (!found) throw new MemoryNoteError(`Memory "${id}" not found.`, 'NOT_FOUND')
  // vale anche per una lapide (la si dimentica dallo storico) e per una
  // nota in quarantena
  const cell = await ownerCell(agentId, found.scope === 'user' ? 'user' : 'bot')
  const view = await cell.purge(found.id, 'user request (Dimentica per sempre)')
  return { forgotten: view.forgottenPayloads, scrubbed: view.scrubbed, pending: view.pending, views: view.views.map((v) => ({ viewId: v.viewId ?? null, root: v.root, reason: v.reason })) }
})

/** Scrittura dall'interfaccia: nuova nota o aggiornamento (actor homun:user). */
export const memorySave = perLaUi(async function memorySave(agentId: string, input: { id?: string; body: string; tier: 'core' | 'log'; scope?: 'agent' | 'user' }): Promise<MemoryNoteInfo> {
  const body = String(input.body ?? '').trim()
  if (!body) throw new MemoryNoteError('Empty memory content: nothing written.', 'INVALID', 'empty')
  if (input.id) {
    const note = await updateMemoryNote(agentId, {
      id: input.id, content: body,
      ...(input.tier ? { tier: input.tier } : {}),
      ...(input.scope ? { scope: input.scope } : {})
    }, { byUser: true })
    const scope = (note.extensions['x-homun'] as { scope?: string } | undefined)?.scope
    return toNoteInfo(note, scope === 'user' ? 'user' : 'bot')
  }
  const note = await writeMemoryNote(agentId, {
    content: body,
    tier: input.tier === 'core' ? 'core' : 'log',
    ...(input.scope === 'user' ? { scope: 'user' } : {}),
    source: 'homun:user',
    userTurn: true
  }, { byUser: true })
  return toNoteInfo(note, input.scope === 'user' ? 'user' : 'bot')
})

// ---- il download del modello (SOLO dal click dell'utente) ----

type MemoryProgress = (done: number, total: number) => void

const modelPullState = { inFlight: false }

/**
 * Avvia il download del modello (~400 MB, revisione agganciata e sha256 per
 * chunk): una sola volta per demone; l'avanzamento esce con progress (i byte
 * del modello non sono contenuti di note). Ritorna false se è già in corso.
 */
export function startModelPull(
  progress: MemoryProgress,
  onDone: (outcome: { ok: boolean; error?: string }) => void
): boolean {
  if (modelPullState.inFlight) return false
  modelPullState.inFlight = true
  void (async () => {
    try {
      const engine = await (await import('./engine')).memoryEngine()
      let last = -1
      await engine.pullModel((done, total) => {
        // il modello non è una nota ma il flusso è lo stesso: throttle al MB
        const mb = Math.floor(done / 1_000_000)
        if (mb !== last) {
          last = mb
          progress(done, total)
        }
      })
      progress(1, 1)
      onDone({ ok: true })
    } catch (e) {
      // E3: la frase del catalogo, non il messaggio del motore (inglese, e con l'indirizzo dell'endpoint)
      onDone({ ok: false, error: modelPullErrorText(e) })
    } finally {
      modelPullState.inFlight = false
    }
  })()
  return true
}
