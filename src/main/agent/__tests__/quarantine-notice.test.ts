// Fase chat-limiti (CL7): una memoria in quarantena la dice L'APP, non il
// modello (che spesso se lo dimenticava): sotto il turno compare una riga di
// sistema «Una cosa da ricordare aspetta la tua conferma» con il bottone che
// apre la sezione Memoria su quella voce. E la regola del prompt: mai dire
// che un'azione è riuscita se il suo strumento ha dato errore.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const { setDataDir } = await import('../../store/db')
const { executeTool, quarantinedMemoryNotice } = await import('../tools')
const { systemPrompt } = await import('../prompts')

const AGENT = 'agent_q7'
let ROOT = ''

beforeAll(async () => {
  ROOT = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-quarantine-notice-'))
  setDataDir(ROOT)
  const { openMemoryEngine } = await import('../../memory/engine')
  const st = await openMemoryEngine({ dataDir: ROOT })
  if (!st.available) throw new Error('motore Engramma non disponibile nei test: ' + st.error)
})
afterAll(async () => {
  const { closeMemoryEngine } = await import('../../memory/engine')
  await closeMemoryEngine()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('CL7: la memoria in quarantena la dice l\'APP (riga di sistema con l\'id)', () => {
  it('update_memory da contenuto esterno → quarantena: la riga di sistema c\'è, con l\'id della memoria', async () => {
    const r = await executeTool(AGENT, 'update_memory', { action: 'write', content: 'V7 Special a 8.900 euro sulla pagina degli annunci' }, { contaminated: true, turnEntryId: 42 })
    expect(r.meta.quarantined).toBe(true)
    const notice = quarantinedMemoryNotice(r.meta)
    expect(notice).not.toBeNull()
    expect(notice!.ui.id).toBe('notice.memoryQuarantined')
    // L'ID: il bottone apre la sezione Memoria SU QUELLA voce
    expect(notice!.memoryId).toBe(String(r.meta.memoryId))
  })

  it('scrittura NORMALE (turno utente pulito) → NESSUNA riga di sistema', async () => {
    const r = await executeTool(AGENT, 'update_memory', { action: 'write', content: 'preferisco le risposte brevi' }, { userTurn: true, turnEntryId: 43 })
    expect(r.meta.quarantined).toBeUndefined()
    expect(quarantinedMemoryNotice(r.meta)).toBeNull()
  })
})

describe('CL7: la regola del prompt — mai dichiarare azioni non riuscite', () => {
  it('il prompt del bot contiene la regola, parola per parola', () => {
    const p = systemPrompt({ id: 'agent_x', name: 'SandBot', description: '', providerId: 'p', model: 'm', status: 'idle', unread: 0, createdAt: 1 }, { subagents: true })
    expect(p).toContain(
      'Never say an action succeeded ("I opened", "I read") when its tool returned an error, a timeout, HTTP 400+, or a non-zero exit code: tell the user how it actually went.'
    )
  })
})

describe('CL7: i testi it/en della riga e del bottone (cataloghi veri)', () => {
  const readPo = (lang: 'it' | 'en'): string =>
    readFileSync(new URL(`../../../renderer/src/locales/${lang}/messages.po`, import.meta.url), 'utf8')

  it('la riga di sistema c\'è in it (msgid esplicito del catalogo UI), tradotta in en', () => {
    const it = readPo('it')
    const itBlock = /msgid "notice\.memoryQuarantined"\nmsgstr "([^"]*)"/.exec(it)
    expect(itBlock).not.toBeNull()
    expect(itBlock?.[1]).toBe('Una cosa da ricordare aspetta la tua conferma.')
    const en = readPo('en')
    const enBlock = /msgid "notice\.memoryQuarantined"\nmsgstr "([^"]*)"/.exec(en)
    expect(enBlock).not.toBeNull()
    expect(enBlock?.[1]).toMatch(/confirm/i)
  })

  it('il bottone «Apri Memoria» c\'è in it, tradotto in en', () => {
    const it = readPo('it')
    expect(it).toContain('Apri Memoria')
    const en = readPo('en')
    const block = /msgid "Apri Memoria"\nmsgstr "([^"]*)"/.exec(en)
    expect(block).not.toBeNull()
    expect(block?.[1]).toMatch(/memory/i)
  })
})
