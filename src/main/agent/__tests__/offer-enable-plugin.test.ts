// V6 (fase stato-vivo): un plugin PRESENTE ma SPENTO non è «uno strumento che
// non esiste» — il bot propone la card offer_enable_plugin (logo, nome, riga
// grigia PL1, la sua frase ripulita come X2, Attiva/Non ora) invece di fare
// curl o dire che non ha il tool. La scheda È la richiesta: niente da
// approvare, solo nei turni dell'utente (CONNECTOR_PROPOSAL_TOOLS), una per
// plugin finché l'utente non risponde, «Non ora» per tutta la conversazione.
// Il click Attiva fa quello che fa l'interruttore V5 e il daemon accoda un
// TURNO NUOVO (initiator PLUGIN_ENABLED_RESUME) SOLO se il test riesce: gli
// strumenti si caricano a inizio turno, cambiarli a metà romperebbe la cache
// del prompt e il catalogo di find_tools.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toolDefs } from '../tools'
import { TOOL_GROUPS } from '../core-tools'
import { CONNECTOR_PROPOSAL_TOOLS, connectorProposalOffered, PLUGIN_ENABLED_RESUME } from '../connectors-policy'
import { connectionsNowSection, CONNECTIONS_NOW_TOKEN_BUDGET } from '../connected-apps'
import { sanitizePluginReason, PLUGIN_REASON_CLIP } from '../../mcp/error-category'

const LOOP = fileURLToPath(new URL('../loop.ts', import.meta.url))

const defOf = (name: string) => toolDefs.find((t) => t.name === name)!

describe('V6: il tool offer_enable_plugin e la regola del prompt', () => {
  it('la descrizione: la card con Attiva, non accende niente da sola, la ripresa al click', () => {
    const d = defOf('offer_enable_plugin')
    expect(d.description).toMatch(/switched-off list/)
    expect(d.description).toMatch(/Enables nothing itself/)
    expect(d.description).toMatch(/user click/)
    expect(d.description).toMatch(/resumes with its tools/)
    expect(d.parameters).toMatchObject({ required: ['plugin_id', 'reason'] })
  })

  it('sta nel gruppo connectors e nella policy dei turni dell\'utente', () => {
    expect(TOOL_GROUPS.find((g) => g.id === 'connectors')!.tools).toContain('offer_enable_plugin')
    expect(CONNECTOR_PROPOSAL_TOOLS.has('offer_enable_plugin')).toBe(true)
  })

  it('nel loop la card nasce dal tool (appendSend type enable-plugin) e il permesso è allow come i fratelli', () => {
    const loop = readFileSync(LOOP, 'utf8')
    expect(loop).toMatch(/call\.name === 'offer_enable_plugin'/)
    expect(loop).toMatch(/type: 'enable-plugin'/)
    const perms = readFileSync(fileURLToPath(new URL('../permissions.ts', import.meta.url)), 'utf8')
    expect(perms).toMatch(/offer_enable_plugin/)
  })

  it('la REGOLA nel blocco «Collegamenti ora» quando c\'è uno spento, parola per parola, col tetto misurato', () => {
    const RULE = 'If a plugin you need is listed as switched off, call offer_enable_plugin instead of using curl or saying you have no tool.'
    const conSpenti = connectionsNowSection({ working: [], failing: [], off: [{ name: 'orion-moon' }], composioApps: [] })
    expect(conSpenti).toContain(RULE)
    // senza spenti la regola non c'è (il blocco resta lean)
    const senza = connectionsNowSection({ working: [{ name: 'x', toolCount: 1 }], failing: [], off: [], composioApps: [] })
    expect(senza).not.toContain('offer_enable_plugin')
    // e il tetto regge col caso pieno (misurato di nuovo con la regola)
    const tok = (s: string): number => Math.ceil(s.length / 4)
    const pieno = connectionsNowSection({
      working: Array.from({ length: 8 }, (_, i) => ({ name: `server-con-nome-lungo-${i}`, toolCount: 10 + i })),
      failing: Array.from({ length: 4 }, (_, i) => ({ name: `rotto-${i}`, category: 'startup-error' as const })),
      off: Array.from({ length: 4 }, (_, i) => ({ name: `spento-${i}` })),
      composioApps: Array.from({ length: 6 }, (_, i) => ({ name: `App${i}`, accounts: [{ alias: `l${i}`, email: `u${i}@a.test` }, { alias: `p${i}`, email: `u${i}@g.test` }, { alias: `x${i}`, email: `u${i}@n.test` }] }))
    })
    expect(tok(pieno)).toBeLessThanOrEqual(CONNECTIONS_NOW_TOKEN_BUDGET)
  })
})

describe('V6: la frase del bot nella card — ripulita come X2 (niente a capo, niente <>, ≤ 160)', () => {
  it('a capo e <tag> spariscono, il tetto è 160', () => {
    expect(PLUGIN_REASON_CLIP).toBe(160)
    const pulita = sanitizePluginReason('per favore\naccendi orion-moon\r\nche mi serve <b>subito</b> per la richiesta dell\'utente')
    expect(pulita).not.toMatch(/[\r\n]/)
    expect(pulita).not.toContain('<')
    expect(pulita).not.toContain('>')
    expect(pulita.length).toBeLessThanOrEqual(160)
    const lunga = sanitizePluginReason('x'.repeat(500))
    expect(lunga.length).toBe(160)
  })
})

describe('V6: il turno di ripresa PLUGIN_ENABLED_RESUME conta come turno dell\'utente', () => {
  it('connectorProposalOffered true (il turno nasce dal click dell\'utente sulla scheda)', () => {
    expect(PLUGIN_ENABLED_RESUME).toBe('PLUGIN_ENABLED_RESUME')
    expect(connectorProposalOffered({ source: 'user', initiator: PLUGIN_ENABLED_RESUME })).toBe(true)
    // gli ALTRI initiator di sistema restano fuori, come sempre
    expect(connectorProposalOffered({ source: 'user', initiator: 'ROUTINE' })).toBe(false)
    expect(connectorProposalOffered({ source: 'user', initiator: 'SHELL_DONE' })).toBe(false)
    expect(connectorProposalOffered({ source: 'routine' })).toBe(false)
  })
})
