// Fase token (T3): le FACCIATE verso il modello (browser, document, task,
// memory) con campo action, srotolate nel loop dal nome interno PRIMA di
// permessi, gate e card. Qui le PURE: costruzione dello schema unione e
// expandFacadeCall con i suoi errori (azione mancante/sconosciuta, parametro
// richiesto mancante). Le interazioni col loop (regole salvate su
// browser_click, CONTAMINATED_ASK_TOOLS) stanno in loop.test.ts.
import { describe, expect, it } from 'vitest'
import { toolDefs, computerToolDefs } from '../tools'
import { browserToolDefs } from '../browser'
import {
  FACADE_ACTIONS, buildFacadeDef, expandFacadeCall, FACADE_DEFS,
  type InternalSchemaOf
} from '../facades'

const byName = new Map([...toolDefs, ...browserToolDefs, ...computerToolDefs].map((t) => [t.name, t]))
const schemaOf: InternalSchemaOf = (name) => byName.get(name) ?? null

describe('fase token (T3): lo schema della facciata', () => {
  it('browser: action enum con le 11 azioni, unione dei parametri, tutti facoltativi tranne action', () => {
    const def = buildFacadeDef('browser', [...browserToolDefs])!
    const params = def.parameters as { properties: Record<string, { type?: string; enum?: string[] }>; required: string[] }
    expect(params.required).toEqual(['action'])
    expect(params.properties.action!.enum).toEqual([
      'open', 'snapshot', 'click', 'type', 'select', 'press_key', 'wait', 'tabs', 'back', 'close', 'screenshot'
    ])
    // unione: url (open), ref (click/type/select), text (type), key (press_key), values (select)…
    for (const p of ['url', 'ref', 'text', 'key', 'values', 'seconds']) expect(params.properties[p]).toBeTruthy()
    // la descrizione: una riga per azione, ≤ 60 caratteri ciascuna
    for (const line of def.description.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(62) // il «- » iniziale è tollerato
    }
    expect(def.description).toContain('open')
    expect(def.description).toContain('screenshot')
  })

  it('ogni parametro porta, tra parentesi, le azioni che lo usano', () => {
    const def = buildFacadeDef('browser', [...browserToolDefs])!
    const props = (def.parameters as { properties: Record<string, { description?: string }> }).properties
    // ref lo usano snapshot (opzionale), click, type e select
    expect(props.ref!.description).toMatch(/\(snapshot, click, type, select\)/)
    expect(props.url!.description).toMatch(/\(open, tabs\)/)
  })

  it('memory: le azioni save/recall/delete (update_memory ha la sua action interna: save=write, id=update, delete=delete)', () => {
    const def = buildFacadeDef('memory', [byName.get('update_memory')!, byName.get('recall_memory')!])!
    const params = def.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] }
    expect(params.properties.action!.enum).toEqual(['save', 'recall', 'delete'])
    expect(params.properties.query).toBeTruthy()
    expect(params.properties.content).toBeTruthy()
    expect(params.properties.tier).toBeTruthy()
    // l'action INTERNA di update_memory non è nell'unione (la facciata la ricava)
    expect(params.required).toEqual(['action'])
  })

  it('document e task: le azioni delle rispettive famiglie', () => {
    const doc = buildFacadeDef('document', [byName.get('write_document')!, byName.get('read_document')!, byName.get('edit_document')!])!
    expect((doc.parameters as { properties: Record<string, { enum?: string[] }> }).properties.action!.enum).toEqual(['write', 'read', 'edit'])
    const task = buildFacadeDef('task', [byName.get('create_task')!, byName.get('update_task')!])!
    expect((task.parameters as { properties: Record<string, { enum?: string[] }> }).properties.action!.enum).toEqual(['create', 'update'])
  })

  it('costruis solo con i tool PRESENTI: il figlio ha memory con sola azione recall', () => {
    const def = buildFacadeDef('memory', [byName.get('recall_memory')!])!
    expect((def.parameters as { properties: Record<string, { enum?: string[] }> }).properties.action!.enum).toEqual(['recall'])
  })
})

describe('fase token (T3): expandFacadeCall', () => {
  const expand = (name: string, args: unknown) =>
    expandFacadeCall({ name, arguments: JSON.stringify(args) }, schemaOf)
  /** l'args dello srotolamento, come OGGETTO (l'ordine delle chiavi JSON non conta) */
  const argsOf = (r: ReturnType<typeof expand>): Record<string, unknown> =>
    r.ok ? JSON.parse(r.arguments) as Record<string, unknown> : {}

  it('srotola ogni azione browser nel tool interno con i parametri esatti', () => {
    let r = expand('browser', { action: 'open', url: 'https://x.test' })
    expect(r).toMatchObject({ ok: true, name: 'browser_open' })
    expect(argsOf(r)).toEqual({ url: 'https://x.test' })
    r = expand('browser', { action: 'click', ref: 'e3' })
    expect(r).toMatchObject({ ok: true, name: 'browser_click' })
    expect(argsOf(r)).toEqual({ ref: 'e3' })
    r = expand('browser', { action: 'type', ref: 'e4', text: 'ciao', submit: true })
    expect(r).toMatchObject({ ok: true, name: 'browser_type' })
    expect(argsOf(r)).toEqual({ ref: 'e4', text: 'ciao', submit: true })
    r = expand('browser', { action: 'screenshot' })
    expect(r).toMatchObject({ ok: true, name: 'browser_screenshot' })
    expect(argsOf(r)).toEqual({})
  })

  it('tabs: il parametro tab diventa l\'action interna di browser_tabs', () => {
    const r = expand('browser', { action: 'tabs', tab: 'new', url: 'https://y.test' })
    expect(r).toMatchObject({ ok: true, name: 'browser_tabs' })
    expect(argsOf(r)).toEqual({ action: 'new', url: 'https://y.test' })
  })

  it('memory: save senza id → update_memory write; con id → update; delete → delete', () => {
    let r = expand('memory', { action: 'save', content: 'x', tier: 'core' })
    expect(r).toMatchObject({ ok: true, name: 'update_memory' })
    expect(argsOf(r)).toEqual({ action: 'write', content: 'x', tier: 'core' })
    r = expand('memory', { action: 'save', id: 'm1', content: 'y', tier: 'log' })
    expect(argsOf(r)).toEqual({ action: 'update', id: 'm1', content: 'y', tier: 'log' })
    r = expand('memory', { action: 'recall', query: 'preferenze' })
    expect(r).toMatchObject({ ok: true, name: 'recall_memory' })
    expect(argsOf(r)).toEqual({ query: 'preferenze' })
    r = expand('memory', { action: 'delete', id: 'm1' })
    expect(argsOf(r)).toEqual({ action: 'delete', id: 'm1' })
  })

  it('document e task: write/read/edit e create/update', () => {
    expect(expand('document', { action: 'write', title: 'T', content: 'C' })).toMatchObject({ ok: true, name: 'write_document' })
    expect(expand('document', { action: 'read', id: 'd1' })).toMatchObject({ ok: true, name: 'read_document' })
    expect(expand('document', { action: 'edit', id: 'd1', edits: [{ old: 'a', new: 'b' }] })).toMatchObject({ ok: true, name: 'edit_document' })
    expect(expand('task', { action: 'create', title: 'T', brief: 'B' })).toMatchObject({ ok: true, name: 'create_task' })
    expect(expand('task', { action: 'update', id: '1', status: 'done', summary: 's' })).toMatchObject({ ok: true, name: 'update_task' })
  })

  it('azione mancante o sconosciuta: errore con le azioni valide, NIENTE esecuzione', () => {
    const no = expand('browser', { url: 'https://x.test' })
    expect(no.ok).toBe(false)
    if (!no.ok) {
      expect(no.error).toContain('open')
      expect(no.error).toContain('screenshot')
      expect(no.error.toLowerCase()).toContain('action')
    }
    const bad = expand('browser', { action: 'dance' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('open')
  })

  it('parametro richiesto dall\'azione interna mancante: errore coi parametri di QUELL\'azione', () => {
    const r = expand('browser', { action: 'type', ref: 'e4' }) // manca text
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('text')
    const d = expand('document', { action: 'write', title: 'T' }) // manca content
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error).toContain('content')
  })

  it('un nome che non è facciata passa invariato', () => {
    const r = expand('web_search', { query: 'x' })
    expect(r).toMatchObject({ ok: true, name: 'web_search' })
    expect(argsOf(r)).toEqual({ query: 'x' })
  })

  it('FACADE_DEFS: le quattro facciate e la mappa azione → tool interno', () => {
    expect(Object.keys(FACADE_DEFS).sort()).toEqual(['browser', 'document', 'memory', 'task'])
    expect(FACADE_DEFS.browser!.actions.click.internal).toBe('browser_click')
    expect(FACADE_ACTIONS.size).toBe(4)
  })
})
