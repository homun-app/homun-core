// Fase token (T1/T2): assembleTurnTools — il NUCLEO piccolo sempre caricato e
// i GRUPPI attivabili. Qui l'aspettativa è quella della fase token: nel turno
// normale restano solo parlare/pc/web/memory/skill/find_tools, tutto il resto
// sta nei gruppi di TOOL_GROUPS (l'indice è nella descrizione di find_tools);
// i gruppi attivati in conversazione entrano in CODA in ordine stabile.
// (T0: la fotografia dell'elenco di PRIMA è in docs/misure/turn-tokens-prima.txt)
import { describe, expect, it } from 'vitest'
import type { ToolDef } from '../llm'
import { toolDefs, computerToolDefs } from '../tools'
import { browserToolDefs } from '../browser'
import { toolsForTurnSource } from '../connectors-policy'
import { subagentToolDenyReason } from '../subagents'
import { TOOL_GROUPS, CORE_TOOL_NAMES } from '../core-tools'
import { assembleTurnTools, activateGroupsResult, groupsNamedInResult, RESULT_ACTIVATES } from '../turn-tools'

const allBrowser = [...browserToolDefs, ...computerToolDefs]
const userBuiltin = toolsForTurnSource(toolDefs, { source: 'user' })
const groupBuiltin = toolsForTurnSource(toolDefs, { source: 'group', groupTurn: {} })
const childBuiltin = toolsForTurnSource(
  toolDefs.filter((t) => subagentToolDenyReason(t.name) === null),
  { source: 'user', subagent: true }
)
const childBrowser = allBrowser.filter((t) => subagentToolDenyReason(t.name) === null)

/** il nucleo del turno normale (T1): parlare, pc, web, memory (facciata), document (facciata, R7.2), skill, spawn_subagent (R8.2), find_tools */
const CORE_NORMAL = [
  'message_user', 'ask_user',
  'run-command', 'read-file', 'write-file', 'list-directory',
  'web_search', 'web_fetch',
  'memory', 'document', 'skill', 'spawn_subagent', 'find_tools'
]

const assembleUser = (over: Partial<Parameters<typeof assembleTurnTools>[0]> = {}) =>
  assembleTurnTools({
    builtins: userBuiltin, browserAvailable: false, browserDefs: [],
    mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [], ...over
  })

describe('fase token (T1): il nucleo sempre caricato', () => {
  it('bot normale senza browser: SOLO il nucleo — niente browser, charts/libreria, task, credenziali, bot…', () => {
    const r = assembleUser()
    expect(r.tools.map((t) => t.name)).toEqual(CORE_NORMAL)
  })

  it('bot normale con browser: STESSO nucleo (il browser è un gruppo, si attiva)', () => {
    const r = assembleUser({ browserAvailable: true, browserDefs: allBrowser })
    expect(r.tools.map((t) => t.name)).toEqual(CORE_NORMAL)
  })

  it('turno di gruppo: send_to_user al posto di message_user, più post_to_group e pass per costruzione', () => {
    const r = assembleTurnTools({
      builtins: groupBuiltin, browserAvailable: false, browserDefs: [],
      mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [], groupTurn: {}
    })
    expect(r.tools.map((t) => t.name)).toEqual([
      'send_to_user', 'ask_user',
      'run-command', 'read-file', 'write-file', 'list-directory',
      'web_search', 'web_fetch',
      'memory', 'document', 'skill', 'find_tools', 'post_to_group', 'pass'
    ])
  })

  it('figlio: nucleo filtrato dalla whitelist (niente ask_user) e wake_parent che chiude', () => {
    const r = assembleTurnTools({
      builtins: childBuiltin, browserAvailable: true, browserDefs: childBrowser,
      mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [], subagent: true
    })
    expect(r.tools.map((t) => t.name)).toEqual([
      'run-command', 'read-file', 'write-file', 'list-directory',
      'web_search', 'web_fetch',
      'memory', 'skill', 'find_tools', 'wake_parent'
    ])
  })

  it('il nucleo e i gruppi coprono TUTTI i builtin: niente tool orfano', () => {
    const grouped = new Set(TOOL_GROUPS.flatMap((g) => [...g.tools]))
    for (const t of toolDefs) {
      if (CORE_TOOL_NAMES.has(t.name)) continue
      expect(grouped.has(t.name), ` ${t.name} non è nel nucleo né in un gruppo`).toBe(true)
    }
  })
})

describe('fase token (T2): i gruppi, l\'indice e l\'attivazione', () => {
  it('la descrizione di find_tools porta l\'indice dei gruppi presenti: una riga «id: descrizione»', () => {
    const r = assembleUser({ browserAvailable: true, browserDefs: allBrowser })
    const ft = r.tools.find((t) => t.name === 'find_tools')!
    for (const g of TOOL_GROUPS) {
      if (g.id === 'browser') expect(ft.description).toContain(`browser: `)
      else if (['documents', 'tasks', 'credentials', 'outside', 'subagents', 'bots', 'connectors', 'apps', 'admin'].includes(g.id)) {
        expect(ft.description).toContain(`${g.id}: `)
      }
    }
    // una riga per gruppo: il numero di righe «id:» è il numero dei gruppi presenti
    const lines = ft.description.split('\n').filter((l) => /^[a-z]+: /.test(l))
    expect(lines).toHaveLength(TOOL_GROUPS.length)
  })

  it('senza browser il gruppo browser NON è nell\'indice', () => {
    const r = assembleUser()
    const ft = r.tools.find((t) => t.name === 'find_tools')!
    expect(ft.description).not.toContain('browser: ')
  })

  it('figlio: solo i gruppi che la whitelist ammette (browser e tasks), gli altri non si trovano', () => {
    const r = assembleTurnTools({
      builtins: childBuiltin, browserAvailable: true, browserDefs: childBrowser,
      mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [], subagent: true
    })
    expect(r.deferredIndex.map((g) => g.id).sort()).toEqual(['browser', 'tasks'])
  })

  it('un gruppo attivato in conversazione entra in CODA, in ordine di TOOL_GROUPS', () => {
    const r = assembleUser({
      browserAvailable: true, browserDefs: allBrowser,
      activatedGroups: ['bots', 'browser']
    })
    const names = r.tools.map((t) => t.name)
    expect(names.slice(0, CORE_NORMAL.length)).toEqual(CORE_NORMAL)
    // ordine di TOOL_GROUPS (browser prima di bots) e i tool del gruppo browser:
    // la facciata browser, poi request_takeover, computer_observe, computer_act
    const tail = names.slice(CORE_NORMAL.length)
    expect(tail).toEqual(['browser', 'request_takeover', 'computer_observe', 'computer_act',
      'list_agents', 'create_agent', 'update_agent', 'delete_agent', 'create_group', 'update_group', 'send_to_agent'])
  })

  it('activateGroupsResult({group}): attiva il gruppo esatto e il result elenca i tool, la guida e le righe finali', () => {
    const r = assembleUser({ browserAvailable: true, browserDefs: allBrowser })
    const act = activateGroupsResult(r.deferredIndex, [], { group: 'browser' })
    expect(act.activated).toEqual(['browser'])
    for (const line of ['Group browser is now active: browser', 'request_takeover', 'computer_observe', 'computer_act']) {
      expect(act.text).toContain(line)
    }
    expect(act.text).toContain('Call these tools directly by name from the next step.')
    // fase token · nucleo (R8.3): la riga che chiude è «chiama ora, non annunciare»
    expect(act.text.trimEnd().endsWith('Now call the tool you need; do not announce it.')).toBe(true)
  })

  it('activateGroupsResult({query}): cerca su id, descrizione dei gruppi, nomi e descrizioni dei tool — max 2 gruppi', () => {
    const r = assembleUser()
    const act = activateGroupsResult(r.deferredIndex, [], { query: 'create a new bot' })
    expect(act.activated[0]).toBe('bots')
    expect(act.activated.length).toBeLessThanOrEqual(2)
    const act2 = activateGroupsResult(r.deferredIndex, [], { query: 'save a document chart in the library' })
    expect(act2.activated[0]).toBe('documents')
    expect(act2.activated.length).toBeLessThanOrEqual(2)
    const act3 = activateGroupsResult(r.deferredIndex, [], { query: 'password login vault' })
    expect(act3.activated[0]).toBe('credentials')
    expect(act3.activated.length).toBeLessThanOrEqual(2)
  })

  it('activateGroupsResult: gruppo sconosciuto o query senza match → niente attivazioni, testo che lo dice', () => {
    const r = assembleUser()
    const unknown = activateGroupsResult(r.deferredIndex, [], { group: 'nope' })
    expect(unknown.activated).toEqual([])
    expect(unknown.text).toContain('nope')
    const none = activateGroupsResult(r.deferredIndex, [], { query: 'zzzzqqqq' })
    expect(none.activated).toEqual([])
    expect(none.text.length).toBeGreaterThan(0)
  })

  it('RESULT_ACTIVATES: run-command (background) nomina await_shell → tasks; web_fetch JS nomina browser_open → browser', () => {
    expect(RESULT_ACTIVATES['run-command']).toEqual(['tasks'])
    expect(RESULT_ACTIVATES['web_fetch']).toEqual(['browser'])
    const r = assembleUser({ browserAvailable: true, browserDefs: allBrowser })
    const bg = 'Command started in background (shellId 7): the turn continues. When it finishes you receive a system message with the outcome, or read it right away with await_shell({shellId: "7"}).'
    expect(groupsNamedInResult(bg, r.deferredIndex)).toEqual(['tasks'])
    const js = 'The page appears to be built in JavaScript: if you need it, open it with browser_open.'
    expect(groupsNamedInResult(js, r.deferredIndex)).toEqual(['browser'])
    // un result che NON nomina tool di gruppi: nessuna attivazione
    expect(groupsNamedInResult('Done. 3 files written.', r.deferredIndex)).toEqual([])
    // una parola che CONTIENE il nome non conta (await_shells ≠ await_shell)
    expect(groupsNamedInResult('the await_shells of tomorrow', r.deferredIndex)).toEqual([])
  })

  it('è pura: stessa input → stessa output, l\'input non cambia', () => {
    const input = {
      builtins: [...userBuiltin], browserAvailable: true, browserDefs: [...allBrowser] as ToolDef[],
      mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [] as string[]
    }
    const before = JSON.stringify(input)
    const a = assembleTurnTools(input)
    const b = assembleTurnTools(input)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(input)).toBe(before)
  })

  it('prefisso stabile: l\'elenco col gruppo attivato cresce SOLO in coda', () => {
    const before = assembleUser()
    const after = assembleUser({ activatedGroups: ['documents'] })
    const k = before.tools.length
    expect(after.tools.slice(0, k).map((t) => t.name)).toEqual(before.tools.map((t) => t.name))
  })
})
