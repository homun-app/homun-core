// BC3 (fase beta.4 — correzioni): un messaggio scritto nella casella mentre
// il turno è fermo su AWAITING_USER e l'ultima entry del bot è una card
// ask_user ancora senza risposta DIVENTA la risposta a quella card
// (respondedTo = id della card, come il campo «Scrivi tu…»: niente bola
// doppia, il modello la riceve come risposta). La logica sta in UN punto
// solo, dove chat:send accoda (enqueueUserMessage) — così vale anche per i
// messaggi che arrivano da altri canali. Una card più vecchia di un'altra
// entry del bot (testo, altra card) NON si collega: conta solo l'ultima.
// Store reale su directory temporanea, come queue.test.ts.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setDataDir, dataDir, db, createAgent, getEntries, appendEntry, updateEntryMeta
} from '../../main/store/db'
import { enqueueUserMessage } from '../enqueue'
import type { SandbotEvent, TranscriptEntry } from '../../shared/types'

const AGENT = 'agent_card'

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)

/** Una card ask_user del bot (send-message assistant, meta.message widget). */
const widgetEntry = (extraMeta: Record<string, unknown> = {}): Parameters<typeof appendEntry>[0] => ({
  agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'Per cosa mi vuoi?',
  meta: {
    message: { type: 'widget', prompt: 'Per cosa mi vuoi?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
    ...extraMeta
  }
})

/** L'evento di fine turno (meta.turnEnd). */
const turnEndEntry = (turnEnd: string): Parameters<typeof appendEntry>[0] => ({
  agentId: AGENT, kind: 'event', role: 'system', content: `[${turnEnd}]`,
  meta: { turnEnd }
})

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-cardanswer-test-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

beforeEach(() => {
  events = []
  const d = db()
  d.exec('DELETE FROM jobs')
  d.exec('DELETE FROM entries')
  d.exec('DELETE FROM agents')
  createAgent('Prova', '')
})

describe('BC3: il messaggio scritto nella casella chiude la card ask_user', () => {
  it('card in attesa (AWAITING_USER) + messaggio → respondedTo e la card mostra «Hai scritto»', () => {
    const card = appendEntry(widgetEntry())
    appendEntry(turnEndEntry('AWAITING_USER'))
    const job = enqueueUserMessage(db(), AGENT, 'Le fatture dei miei clienti', undefined, emit)!
    expect(job).toBeTruthy()
    expect(job.payload).toMatchObject({ text: 'Le fatture dei miei clienti', respondedTo: card.id })
    // la card registra la risposta libera, come il campo «Scrivi tu…»
    const updated = getEntries(AGENT).find((e) => e.id === card.id)!
    expect((updated.meta as { respondedValue?: unknown }).respondedValue).toBe('Le fatture dei miei clienti')
  })

  it('card GIÀ risposta → il messaggio resta un messaggio normale (niente respondedTo)', () => {
    const card = appendEntry(widgetEntry())
    appendEntry(turnEndEntry('AWAITING_USER'))
    updateEntryMeta(card.id, { ...card.meta, respondedValue: 'a' })
    const job = enqueueUserMessage(db(), AGENT, 'un altro messaggio', undefined, emit)!
    expect(job.payload).toEqual({ text: 'un altro messaggio' })
  })

  it('card seguita da un messaggio del bot (turno dopo, FINISHED) → niente collegamento', () => {
    const card = appendEntry(widgetEntry())
    appendEntry(turnEndEntry('AWAITING_USER'))
    appendEntry({ agentId: AGENT, kind: 'message', role: 'user', content: 'primo messaggio' })
    appendEntry({ agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'una risposta del bot', meta: { message: { type: 'text', text: 'una risposta del bot' } } })
    appendEntry(turnEndEntry('FINISHED'))
    const job = enqueueUserMessage(db(), AGENT, 'secondo messaggio', undefined, emit)!
    expect(job.payload).toEqual({ text: 'secondo messaggio' })
    const updated = getEntries(AGENT).find((e) => e.id === card.id)! as TranscriptEntry
    expect((updated.meta as { respondedValue?: unknown }).respondedValue).toBeUndefined()
  })

  it('senza AWAITING_USER (nessun turno aperto) → niente collegamento', () => {
    const card = appendEntry(widgetEntry())
    appendEntry(turnEndEntry('FINISHED'))
    const job = enqueueUserMessage(db(), AGENT, 'ciao', undefined, emit)!
    expect(job.payload).toEqual({ text: 'ciao' })
    expect(job.payload).not.toHaveProperty('respondedTo')
  })

  it('la card di un TASK non si collega dalla casella della chat (si risponde nella vista del task)', () => {
    appendEntry(widgetEntry({ taskId: 7 }))
    appendEntry({ ...turnEndEntry('AWAITING_USER'), meta: { turnEnd: 'AWAITING_USER', taskId: 7 } })
    const job = enqueueUserMessage(db(), AGENT, 'dalla chat principale', undefined, emit)!
    expect(job.payload).toEqual({ text: 'dalla chat principale' })
  })
})
