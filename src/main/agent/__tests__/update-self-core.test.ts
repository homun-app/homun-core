// BU1 (fase beta.4 — update_self nel nucleo vero): due fonti di verità per
// «il nucleo» (CORE_TOOL_NAMES e CORE_ORDER) e nessun test che le legava —
// B2 aveva messo update_self nella prima ma non nella seconda, e il turno lo
// costruiva (e lo costruisce) da CORE_ORDER: il prompt nominava un tool che
// il modello non aveva, fuori dal turno di presentazione. Qui il LEGAME e i
// turni veri. Test scritti PRIMA della correzione e visti fallire.
import { describe, expect, it } from 'vitest'
import { toolDefs } from '../tools'
import { toolsForTurnSource } from '../connectors-policy'
import { subagentToolDenyReason } from '../subagents'
import { CORE_TOOL_NAMES } from '../core-tools'
import { assembleTurnTools, CORE_ORDER } from '../turn-tools'

const userBuiltin = () => toolsForTurnSource(toolDefs, { source: 'user' })
const assembleUser = (over: Partial<Parameters<typeof assembleTurnTools>[0]> = {}) =>
  assembleTurnTools({
    builtins: userBuiltin(), browserAvailable: false, browserDefs: [],
    mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [], ...over
  })

describe('BU1: una sola verità per il nucleo', () => {
  it('ogni nome di CORE_TOOL_NAMES sta in CORE_ORDER, salvo i tool che esistono per costruzione nei turni di gruppo', () => {
    // pass e post_to_group non stanno in CORE_ORDER: li aggiunge l'assemblaggio
    // SOLO nei turni di gruppo (per costruzione), come wake_parent nel figlio
    const CONSTRUCTION_ONLY = new Set(['pass', 'post_to_group'])
    for (const name of CORE_TOOL_NAMES) {
      if (CONSTRUCTION_ONLY.has(name)) continue
      expect(CORE_ORDER.includes(name), `${name} è nel nucleo (CORE_TOOL_NAMES) ma non in CORE_ORDER: assembleTurnTools non lo carica mai`).toBe(true)
    }
  })
})

describe('BU1: update_self nel turno vero', () => {
  it('il nucleo del bot normale, turno dell\'utente, contiene update_self SUBITO DOPO ask_user', () => {
    const names = assembleUser().tools.map((t) => t.name)
    expect(names).toContain('update_self')
    // profilo e domanda vanno insieme, e l'ordine resta stabile
    expect(names.indexOf('update_self')).toBe(names.indexOf('ask_user') + 1)
  })

  it('nel FIGLIO update_self resta ESCLUSO: il profilo del padre non si tocca', () => {
    expect(subagentToolDenyReason('update_self')).toBeTruthy()
    const childBuiltin = toolsForTurnSource(
      toolDefs.filter((t) => subagentToolDenyReason(t.name) === null),
      { source: 'user', subagent: true }
    )
    const names = assembleTurnTools({
      builtins: childBuiltin, browserAvailable: false, browserDefs: [],
      mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [], subagent: true
    }).tools.map((t) => t.name)
    expect(names).not.toContain('update_self')
  })
})
