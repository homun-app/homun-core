// Test di update_state (fase 4, §3ter T4): verdetto puro (create/pause/delete
// sempre; resume e update di schedule/prompt su routine ATTIVA chiedono),
// esecuzione con store reale (routine che nasce in pausa con provenance
// 'agent', cron non valido → errore leggibile, evento automation).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatUi } from '../../../shared/ui-text'

const { setDataDir, dataDir, createRoutine, getRoutine, updateRoutine } = await import('../../store/db')
const { updateStateVerdict, automationEventText } = await import('../update-state')
const { executeTool } = await import('../tools')

let root: string
const AGENT = 'agent_us'
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-upstate-test-'))
  setDataDir(root)
  dataDir()
  // fase memoria-engramma (M3): le memorie vivono nel motore Engramma
  const { openMemoryEngine } = await import('../../memory/engine')
  const st = await openMemoryEngine({ dataDir: root })
  if (!st.available) throw new Error('motore Engramma non disponibile nei test: ' + st.error)
})
afterAll(async () => {
  const { closeMemoryEngine } = await import('../../memory/engine')
  await closeMemoryEngine()
  rmSync(root, { recursive: true, force: true })
})

const routine = (over: Partial<Parameters<typeof createRoutine>[4]> = {}) =>
  createRoutine(AGENT, 'Riepilogo mattina', 'riassumi le email', '30 8 * * 1-5', over)

describe('verdetto (puro)', () => {
  it('target memory: sempre consentito (come update_memory)', () => {
    expect(updateStateVerdict({ target: 'memory', action: 'write', content: 'x', tier: 'core' }, null)).toEqual({ kind: 'allow' })
  })

  it('create / pause / delete: sempre consentiti (create nasce in pausa)', () => {
    expect(updateStateVerdict({ target: 'routine', action: 'create', name: 'X' }, null)).toEqual({ kind: 'allow' })
    expect(updateStateVerdict({ target: 'routine', action: 'pause', id: 1 }, routine())).toEqual({ kind: 'allow' })
    expect(updateStateVerdict({ target: 'routine', action: 'delete', id: 1 }, routine())).toEqual({ kind: 'allow' })
  })

  // ---- M3 (fase 0.3.1001): create activate:true, un solo consenso informato ----

  it('create activate:true nel turno DELL’UTENTE → ask con la card che dice che partirà da sola', () => {
    const v = updateStateVerdict(
      { target: 'routine', action: 'create', name: 'Backup', prompt: 'fai il backup', schedule: '0 9 * * *', timezone: 'Europe/Rome', activate: true },
      null,
      { userDirectTurn: true }
    )
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') {
      expect(v.reason).toContain('Backup')
      expect(v.reason).toContain('ACTIVE')
      expect(v.reason).toContain('Europe/Rome')
      expect(v.reason).toContain('fai il backup')
      expect(v.ui?.id).toBe('approval.usCreateActive')
    }
  })

  it('create activate:true FUORI dal turno dell’utente → allow: nasce in pausa come oggi', () => {
    expect(updateStateVerdict(
      { target: 'routine', action: 'create', name: 'Backup', prompt: 'p', schedule: '0 9 * * *', activate: true },
      null
    )).toEqual({ kind: 'allow' })
    expect(updateStateVerdict(
      { target: 'routine', action: 'create', name: 'Backup', prompt: 'p', schedule: '0 9 * * *', activate: true },
      null,
      { userDirectTurn: false }
    )).toEqual({ kind: 'allow' })
  })

  it('create SENZA activate resta allow anche nel turno dell’utente', () => {
    expect(updateStateVerdict(
      { target: 'routine', action: 'create', name: 'X', prompt: 'p', schedule: '0 9 * * *' },
      null,
      { userDirectTurn: true }
    )).toEqual({ kind: 'allow' })
  })

  it('resume → ask con nome, schedule in linguaggio naturale e prompt', () => {
    const r = routine()
    const v = updateStateVerdict({ target: 'routine', action: 'resume', id: r.id }, r)
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') {
      // fase 17c (C2): reason inglese per il modello (cron en); ui per la card
      expect(v.reason).toContain('Riepilogo mattina')
      expect(v.reason).toContain('on weekdays')
      expect(v.reason).toContain('riassumi le email')
      expect(v.ui?.id).toBe('approval.usResume')
    }
  })

  it('update: ask SOLO se la routine è attiva E cambia schedule o prompt', () => {
    const active = routine({ enabled: 1 })
    const paused = routine({ enabled: 0 })
    // attiva + nuova schedule → ask
    expect(updateStateVerdict({ target: 'routine', action: 'update', id: active.id, schedule: '0 9 * * *' }, active).kind).toBe('ask')
    // attiva + nuovo prompt → ask
    expect(updateStateVerdict({ target: 'routine', action: 'update', id: active.id, prompt: 'nuovo' }, active).kind).toBe('ask')
    // attiva + solo nome → allow (non cambia l'esecuzione)
    expect(updateStateVerdict({ target: 'routine', action: 'update', id: active.id, name: 'Altro nome' }, active)).toEqual({ kind: 'allow' })
    // in pausa: anche schedule/prompt → allow
    expect(updateStateVerdict({ target: 'routine', action: 'update', id: paused.id, schedule: '0 9 * * *' }, paused)).toEqual({ kind: 'allow' })
  })

  it('routine inesistente: resume/update vanno avanti (errore leggibile dall\'esecuzione)', () => {
    expect(updateStateVerdict({ target: 'routine', action: 'resume', id: 999 }, null)).toEqual({ kind: 'allow' })
  })
})

describe('esecuzione (store reale)', () => {
  it('create → routine in PAUSA con provenance agent + meta.automation per l\'evento', async () => {
    const { output, meta } = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create',
      name: 'Monitor menzioni', prompt: 'cerca menzioni e riporta', schedule: '30 8 * * 1-5',
      description: 'monitor quotidiano', timezone: 'Europe/Rome'
    })
    expect(output).toContain('PAUSED')
    const r = getRoutine((meta.automation as { id: number }).id)!
    expect(r.enabled).toBe(0)
    expect(r.provenance).toBe('agent')
    expect(r.title).toBe('Monitor menzioni')
    expect(r.description).toBe('monitor quotidiano')
    expect(r.timezone).toBe('Europe/Rome')
    expect(meta.automation).toMatchObject({ action: 'create', name: 'Monitor menzioni' })
    // fase 17c (C2): automationEventText torna l'UiText; il testo si formatta
    expect(formatUi(automationEventText('create', 'Monitor menzioni'), 'it')).toBe('Routine creata (in pausa): Monitor menzioni')
  })

  it('cron non valido → errore leggibile per il modello, NESSUNA routine creata', async () => {
    const before = (await import('../../store/db')).listRoutines(AGENT).length
    const { output, meta } = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Sbagliata', prompt: 'x', schedule: 'non-un-cron'
    })
    expect(output).toContain('Invalid schedule')
    expect(output).toContain('"0 9 * * *"')
    expect(meta.automation).toBeUndefined()
    expect((await import('../../store/db')).listRoutines(AGENT)).toHaveLength(before)
  })

  // ---- M3 (fase 0.3.1001): create activate, esecuzione ----

  it('create activate:true con routineActivateOk → nasce ATTIVA, evento «creata ATTIVA»', async () => {
    const { output, meta } = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create',
      name: 'Backup attivo', prompt: 'fai il backup', schedule: '0 9 * * *', timezone: 'Europe/Rome',
      activate: true
    }, { routineActivateOk: true })
    expect(output).toContain('ACTIVE')
    expect(output).not.toContain('PAUSED')
    const r = getRoutine((meta.automation as { id: number }).id)!
    expect(r.enabled).toBe(1)
    expect(formatUi(automationEventText('create', 'Backup attivo', { active: true }), 'it')).toBe('Routine creata ATTIVA: Backup attivo')
  })

  it('create activate:true SENZA routineActivateOk → ignorato: nasce in PAUSA e il result lo dice', async () => {
    const { output, meta } = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Backup forzato', prompt: 'p', schedule: '0 9 * * *', activate: true
    })
    expect(output).toContain('PAUSED')
    expect(output).toContain('activate ignored')
    const r = getRoutine((meta.automation as { id: number }).id)!
    expect(r.enabled).toBe(0)
  })

  it('create activate:true con provenance template → resta in pausa anche nel turno giusto', async () => {
    const { output, meta } = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Da template attiva', prompt: 'p',
      trigger: { type: 'schedule', kind: 'cron', cron: '0 9 * * *' }, provenance: 'template', activate: true
    }, { turnInitiator: 'TEMPLATE_IMPORT', routineActivateOk: true })
    expect(output).toContain('PAUSED')
    const r = getRoutine((meta.automation as { id: number }).id)!
    expect(r.enabled).toBe(0)
    expect(r.provenance).toBe('template')
  })

  // ---- fase 7: create con trigger schedule opzionale e provenance template ----

  it('create con trigger cron: routine in pausa, trigger_json salvato, cron nella colonna schedule', async () => {
    const { output, meta } = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Da template', prompt: 'p',
      trigger: { type: 'schedule', kind: 'cron', cron: '30 8 * * 1-5' }, provenance: 'template'
    }, { turnInitiator: 'TEMPLATE_IMPORT' })
    expect(output).toContain('PAUSED')
    expect(output).toContain('provenance template')
    const id = (meta.automation as { id: number }).id
    const r = getRoutine(id)!
    expect(r.enabled).toBe(0)
    expect(r.provenance).toBe('template')
    expect(r.schedule).toBe('30 8 * * 1-5')
    expect(r.trigger).toEqual({ type: 'schedule', kind: 'cron', cron: '30 8 * * 1-5' })
  })

  // correzione A5: la provenance 'template' non si accetta da un turno qualsiasi
  it('create con provenance template FUORI dal kickstart: la routine nasce provenance agent', async () => {
    const { output, meta } = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Falsa template', prompt: 'p',
      schedule: '0 9 * * *', provenance: 'template'
    })
    expect(output).toContain('provenance agent')
    const r = getRoutine((meta.automation as { id: number }).id)!
    expect(r.provenance).toBe('agent')
  })

  it('create con trigger every: colonna schedule vuota (nessun cron), trigger_json pieno', async () => {
    const { meta } = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Ogni giorno circa', prompt: 'p',
      trigger: { type: 'schedule', kind: 'every', every: 'day', at: '09:00', mode: 'around' }
    })
    const r = getRoutine((meta.automation as { id: number }).id)!
    expect(r.schedule).toBe('')
    expect(r.trigger).toMatchObject({ type: 'schedule', kind: 'every', every: 'day', mode: 'around' })
    expect(r.enabled).toBe(0)
    expect(r.provenance).toBe('agent') // default senza provenance esplicita
  })

  it('create con trigger NON schedule (webhook/poll): rifiuto leggibile, niente routine', async () => {
    const before = (await import('../../store/db')).listRoutines(AGENT).length
    const webhook = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Hook', prompt: 'p',
      trigger: { type: 'webhook', token: 't' }
    })
    expect(webhook.output).toContain('accepts only schedule-type triggers')
    expect(webhook.meta.automation).toBeUndefined()
    const poll = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Poll', prompt: 'p',
      trigger: { type: 'connector_poll', connectorId: 'x', tool: 't', intervalMin: 5, idField: 'items[].id' }
    })
    expect(poll.output).toContain('accepts only schedule-type triggers')
    expect((await import('../../store/db')).listRoutines(AGENT)).toHaveLength(before)
  })

  it('create con trigger schedule malformato: stessi errori delle routine utente', async () => {
    const before = (await import('../../store/db')).listRoutines(AGENT).length
    const badCron = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Nope', prompt: 'p',
      trigger: { type: 'schedule', kind: 'cron', cron: '9 * * *' }
    })
    expect(badCron.output).toContain('invalid cron')
    const badEvery = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Nope2', prompt: 'p',
      trigger: { type: 'schedule', kind: 'every', every: 'mese', at: '09:00', mode: 'at' }
    })
    // fase 18a (E0): il result del tool è per il MODELLO — inglese, sempre
    expect(badEvery.output).toContain('schedule: invalid every ("mese")')
    expect((await import('../../store/db')).listRoutines(AGENT)).toHaveLength(before)
  })

  it('pause → enabled 0 con evento; resume → enabled 1 con evento', async () => {
    const created = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Giro prova', prompt: 'p', schedule: '0 9 * * *'
    })
    const id = (created.meta.automation as { id: number }).id
    const paused = await executeTool(AGENT, 'update_state', { target: 'routine', action: 'pause', id })
    expect(paused.meta.automation).toMatchObject({ action: 'pause', name: 'Giro prova' })
    expect(getRoutine(id)!.enabled).toBe(0)
    const resumed = await executeTool(AGENT, 'update_state', { target: 'routine', action: 'resume', id })
    expect(resumed.meta.automation).toMatchObject({ action: 'resume', name: 'Giro prova' })
    expect(getRoutine(id)!.enabled).toBe(1)
    expect(formatUi(automationEventText('resume', 'Giro prova'), 'it')).toBe('Routine attivata: Giro prova')
  })

  it('update cambia i campi; delete elimina con l\'evento', async () => {
    const created = await executeTool(AGENT, 'update_state', {
      target: 'routine', action: 'create', name: 'Da aggiornare', prompt: 'p', schedule: '0 9 * * *'
    })
    const id = (created.meta.automation as { id: number }).id
    await executeTool(AGENT, 'update_state', { target: 'routine', action: 'update', id, prompt: 'nuovo prompt', schedule: '30 7 * * *' })
    expect(getRoutine(id)!.prompt).toBe('nuovo prompt')
    expect(getRoutine(id)!.schedule).toBe('30 7 * * *')
    const deleted = await executeTool(AGENT, 'update_state', { target: 'routine', action: 'delete', id })
    expect(deleted.meta.automation).toMatchObject({ action: 'delete', name: 'Da aggiornare' })
    expect(getRoutine(id)).toBeNull()
  })

  it('target memory: write come update_memory (file creato)', async () => {
    const { output, meta } = await executeTool(AGENT, 'update_state', {
      target: 'memory', action: 'write', content: 'preferenza ricordata', tier: 'core'
    })
    expect(output).toContain('Memory created')
    // fase memoria-engramma: la nota sta nella cella del bot
    const { botCell } = await import('../../memory/engine')
    const note = await (await botCell(AGENT)).get(String(meta.memoryId))
    expect(note!.body).toBe('preferenza ricordata')
  })
})

// import a livello modulo (dentro describe non è consentito await); updateRoutine
// e createRoutine sono già importati in testa al file
const { addGrant, createAgent, deleteAgent, getAgent } = await import('../../store/db')
const { writeMemoryNote } = await import('../../memory/memory-store')
const { writeSkillFromBot, listLibrarySkills } = await import('../skills')
const { check } = await import('../permissions')

describe('fase 5 — residui (M1, M3, 0d) con store reale', () => {

  it('M1: pausa → update del prompt → resume: la card arriva SEMPRE sul resume (grant vecchia nel DB)', async () => {
    const r = createRoutine(AGENT, 'Riepilogo', 'p', '30 8 * * 1-5', { enabled: 1 })
    // grant salvata prima della fase 5 (oggi ignorata dal gate)
    addGrant('update_state', `routine ${r.id}`)
    expect((await check('update_state', { target: 'routine', action: 'pause', id: r.id }, AGENT)).kind).toBe('allow')
    updateRoutine(r.id, { enabled: 0 })
    expect((await check('update_state', { target: 'routine', action: 'update', id: r.id, prompt: 'prompt cambiato in pausa' }, AGENT)).kind).toBe('allow')
    const v = await check('update_state', { target: 'routine', action: 'resume', id: r.id }, AGENT)
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') expect(v.reason).toContain('Riepilogo')
  })

  it('M3: update/delete di una memoria ESISTENTE di scope user chiede anche senza scope nell\'argomento', async () => {
    const shared = await writeMemoryNote(AGENT, { content: 'regola condivisa', tier: 'core', scope: 'user', source: 'test', userTurn: true })
    const own = await writeMemoryNote(AGENT, { content: 'fatto privato', tier: 'core', scope: 'agent', source: 'test', userTurn: true })
    // update senza scope nell'argomento: lo scope reale della memoria decide
    const v = await check('update_memory', { action: 'update', id: shared.id, content: 'regola manipolata' }, AGENT)
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') expect(v.reason).toContain('regola manipolata')
    // la memoria dello scope agente resta always_allow
    expect(await check('update_memory', { action: 'update', id: own.id, content: 'aggiornato' }, AGENT)).toEqual({ kind: 'allow', via: 'rule' })
    // delete di una condivisa chiede; delete di una privata no
    expect((await check('update_memory', { action: 'delete', id: shared.id }, AGENT)).kind).toBe('ask')
    expect(await check('update_memory', { action: 'delete', id: own.id }, AGENT)).toEqual({ kind: 'allow', via: 'rule' })
    // ask ≠ eseguito: la nota condivisa è ancora lì
    const { userCell } = await import('../../memory/engine')
    expect(await (await userCell(AGENT)).get(shared.id)).not.toBeNull()
  })

  it('0d: agents:delete rimuove la directory agents/<id>/ e DROPPA la cella del motore', async () => {
    const a = createAgent('Eliminami')
    await writeMemoryNote(a.id, { content: 'ricordo', tier: 'core', source: 'test', userTurn: true })
    writeSkillFromBot(a.id, { name: 'prova', description: 'd', content: 'istruzioni' })
    // fase skill (S2): la skill del bot nasce nella LIBRERIA unica, abilitata
    // solo per lui
    expect(listLibrarySkills().some((sk) => sk.name === 'prova' && sk.entry.enabledFor.includes(a.id))).toBe(true)
    // fase memoria-engramma: la memoria non vive più in agents/<id>/memory —
    // la cartella resta per i vecchi dati (es. la memory/ svuotata dalla
    // migrazione) e deleteAgent la rimuove comunque
    const dir = join(root, 'agents', a.id)
    mkdirSync(join(dir, 'memory'), { recursive: true })
    expect(existsSync(dir)).toBe(true)
    deleteAgent(a.id)
    // fase memoria-engramma · correzioni C2: l'oblio è PER CELLA —
    // dropCellAndEvict su bot-<id> (e storia-<id>): la cella SPARISCE
    const { dropCellAndEvict, botCellName, storyCellName, memoryEngine } = await import('../../memory/engine')
    const r = await dropCellAndEvict(botCellName(a.id), 'bot deleted')
    expect(r.notes).toBe(1)
    await dropCellAndEvict(storyCellName(a.id), 'bot deleted')
    const engine = await memoryEngine()
    expect(await engine.cells()).toEqual(expect.not.arrayContaining([botCellName(a.id), storyCellName(a.id)]))
    expect(getAgent(a.id)).toBeNull()
    expect(existsSync(dir)).toBe(false)
    // id inesistente: no-op senza errori
    deleteAgent('agent_inesistente')
  })
})
