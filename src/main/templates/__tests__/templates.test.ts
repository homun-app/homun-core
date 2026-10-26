// Test dei template (fase 7): validazione dello schema (pura), i 6 template
// del catalogo passano, i trigger NON schedule sono rifiutati, e la
// generazione del messaggio di kickstart contiene JSON e istruzioni.
import { describe, expect, it } from 'vitest'
import { validateTemplate, loadTemplates, templateById, buildKickstartMessage, kickstartInstructions } from '../index'
import inboxManager from '../inbox-manager.json'

/** Un template valido minimalissimo, da rompere in modi mirati. */
function validTemplate(): Record<string, unknown> {
  return {
    id: 'prova',
    name: 'Prova',
    description: 'desc',
    avatar: '🙂',
    roles: ['test'],
    routines: [
      {
        name: 'R',
        slug: 'r',
        description: 'd',
        content: 'contenuto',
        trigger: { type: 'schedule', kind: 'cron', cron: '0 9 * * *' },
        askUserFor: ['fuso orario?']
      }
    ],
    connectors: [{ connectorId: 'gmail', why: 'posta' }],
    memories: [{ content: 'regola', created_at: '2026-10-27' }],
    skills: []
  }
}

describe('validateTemplate (schema puro)', () => {
  it('accetta un template ben formato', () => {
    expect(validateTemplate(validTemplate())).toEqual([])
  })

  it('rifiuta id/nome/descrizione/avatar mancanti o malformati', () => {
    const t = validTemplate()
    delete (t as Record<string, unknown>).name
    t.id = 'Non_Valido'
    t.avatar = ''
    const errors = validateTemplate(t)
    expect(errors.some((e) => e.includes('id'))).toBe(true)
    expect(errors.some((e) => e.includes('name'))).toBe(true)
    expect(errors.some((e) => e.includes('avatar'))).toBe(true)
  })

  it('rifiuta routine senza testi (name/slug/description/content) o con askUserFor non lista', () => {
    const t = validTemplate()
    const r = (t.routines as Array<Record<string, unknown>>)[0]!
    delete r.content
    r.askUserFor = 'fuso?'
    const errors = validateTemplate(t)
    expect(errors.some((e) => e.includes('content'))).toBe(true)
    expect(errors.some((e) => e.includes('askUserFor'))).toBe(true)
  })

  it('SOLO trigger schedule: webhook e connector_poll sono rifiutati', () => {
    const t1 = validTemplate()
    ;(t1.routines as Array<Record<string, unknown>>)[0]!.trigger = { type: 'webhook', token: 'x' }
    expect(validateTemplate(t1).some((e) => e.includes('schedule'))).toBe(true)

    const t2 = validTemplate()
    ;(t2.routines as Array<Record<string, unknown>>)[0]!.trigger = {
      type: 'connector_poll', connectorId: 'gmail', tool: 't', intervalMin: 5, idField: 'messages[].id'
    }
    expect(validateTemplate(t2).some((e) => e.includes('schedule'))).toBe(true)
  })

  it('rifiuta cron non valido nel trigger della routine', () => {
    const t = validTemplate()
    ;(t.routines as Array<Record<string, unknown>>)[0]!.trigger = { type: 'schedule', kind: 'cron', cron: 'nope' }
    expect(validateTemplate(t).some((e) => e.includes('routine 0'))).toBe(true)
  })

  it('accetta il trigger schedule every (at/around)', () => {
    const t = validTemplate()
    ;(t.routines as Array<Record<string, unknown>>)[0]!.trigger = { type: 'schedule', kind: 'every', every: 'day', at: '09:00', mode: 'around' }
    expect(validateTemplate(t)).toEqual([])
  })

  it('rifiuta connettori senza why e memorie senza data', () => {
    const t = validTemplate()
    t.connectors = [{ connectorId: 'gmail' }]
    t.memories = [{ content: 'solo contenuto' }]
    const errors = validateTemplate(t)
    expect(errors.some((e) => e.includes('connettore 0'))).toBe(true)
    expect(errors.some((e) => e.includes('memoria 0'))).toBe(true)
  })

  it('rifiuta skill con nome non [a-z0-9-] o testi mancanti', () => {
    const t = validTemplate()
    t.skills = [{ name: 'Non_Valido', description: 'd', content: 'c' }]
    expect(validateTemplate(t).some((e) => e.includes('skill 0'))).toBe(true)
  })
})

describe('il catalogo dei 6 template', () => {
  it('i 6 template passano la validazione e hanno id unici', () => {
    const all = loadTemplates()
    expect(all.map((t) => t.id).sort()).toEqual(
      ['chief-of-staff', 'daily-briefing', 'executive-assistant', 'inbox-manager', 'meeting-prep', 'mention-monitor']
    )
    expect(new Set(all.map((t) => t.id)).size).toBe(6)
  })

  it('ogni routine del catalogo segue la struttura del prompt (pausa, memoria, anti-invenzione, consegna, ledger, trigger)', () => {
    for (const t of loadTemplates()) {
      for (const r of t.routines) {
        expect(r.content).toContain('PAUSA')
        expect(r.content.toLowerCase()).toContain('memoria')
        expect(r.content).toContain('anti-invenzione')
        expect(r.content.toLowerCase()).toContain('silenzio')
        expect(r.content.toLowerCase()).toContain('ledger')
        expect(r.trigger.type).toBe('schedule')
        expect(r.askUserFor.length).toBeGreaterThan(0)
      }
    }
  })

  it('le memorie del catalogo sono regole operative datate', () => {
    for (const t of loadTemplates()) {
      for (const m of t.memories) {
        expect(m.created_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(m.content.length).toBeGreaterThan(10)
      }
    }
  })

  it('i connettori citati esistono nel catalogo dei connettori', async () => {
    const { loadCatalog } = await import('../../connectors')
    const ids = new Set(loadCatalog().map((c) => c.id))
    for (const t of loadTemplates()) {
      for (const k of t.connectors) expect(ids.has(k.connectorId)).toBe(true)
    }
  })

  it('templateById trova per id e null per id sconosciuto', () => {
    expect(templateById('inbox-manager')?.name).toBeTruthy()
    expect(templateById('manca')).toBeNull()
  })
})

describe('buildKickstartMessage', () => {
  it('contiene il JSON del template nel blocco context e le istruzioni numerate', () => {
    const msg = buildKickstartMessage(inboxManager as never)
    expect(msg).toContain('<bot_template_setup_context>')
    expect(msg).toContain('</bot_template_setup_context>')
    expect(msg).toContain('"routines"')
    expect(msg).toContain('"askUserFor"')
    expect(msg).toContain('<bot_template_setup_instructions>')
    expect(msg).toContain('</bot_template_setup_instructions>')
    expect(msg).toMatch(/1\. Presentati/)
    expect(msg).toMatch(/10\. /)
  })

  it('le istruzioni adattate ai nostri tool: update_state in pausa provenance template, resume dalla card, search_connectors/offer_connector, memorie log/agent', () => {
    const all = kickstartInstructions().join('\n')
    expect(all).toContain('provenance "template"')
    expect(all).toContain('pausa')
    expect(all).toContain('"resume"')
    expect(all).toContain('search_connectors')
    expect(all).toContain('offer_connector')
    expect(all).toContain('tier "log"')
    expect(all).toContain('update_skill')
    expect(all).toContain('askUserFor')
  })
})
