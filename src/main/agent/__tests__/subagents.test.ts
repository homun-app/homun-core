// Test PURI della policy dei sottoagenti (fase 12, punti 2-3): la whitelist
// dei tool del figlio coi motivi dei rifiuti, la validazione del brief, i
// limiti e la decisione di chiusura robusta (subagentClosure). Niente store,
// niente daemon.
import { describe, expect, it } from 'vitest'
import {
  subagentToolAllowed, subagentToolDenyReason, subagentBriefError, subagentClosure,
  autoCloseSummary, expiredSummary, SHORT_BRIEF_ERROR, AUTO_CLOSE_NOTE,
  MAX_SPAWNS_PER_TURN, MAX_OPEN_SUBAGENTS, WAKE_SUMMARY_MAX_CHARS, SUBAGENT_RECOVERY_NUDGE
} from '../subagents'

describe('fase 12 (punto 3): la whitelist dei tool del figlio', () => {
  it('i tool AMMESSI: lavoro, file, web, memoria/skill in lettura, browser, connettori, wake_parent', () => {
    for (const tool of [
      'run-command', 'await_shell', 'read-file', 'write-file', 'list-directory',
      'web_search', 'web_fetch', 'recall_memory', 'skill', 'wake_parent',
      'browser_open', 'browser_snapshot', 'browser_click', 'browser_type',
      'mcp__gmail__search', 'mcp__notion__create_page'
    ]) {
      expect(subagentToolAllowed(tool), tool).toBe(true)
      expect(subagentToolDenyReason(tool), tool).toBeNull()
    }
  })
  it('i tool ESCLUSI hanno un motivo: comunicazione, annidamento, task, scrittura memoria, copie, app', () => {
    const cases: Array<[string, string]> = [
      ['send_to_user', 'non parla'],
      ['ask_user', 'non parla'],
      ['send_to_agent', 'non parla'],
      ['post_to_group', 'non parla'],
      ['pass', 'non parla'],
      ['spawn_subagent', 'niente sottoagenti dentro sottoagenti'],
      ['check_subagent', 'niente sottoagenti dentro sottoagenti'],
      ['create_task', 'task'],
      ['update_task', 'task'],
      ['update_memory', 'sola lettura'],
      ['update_skill', 'sola lettura'],
      ['update_state', 'sola lettura'],
      ['copy_to_box', 'padre'],
      ['copy_from_box', 'padre'],
      ['use-app', 'computer dell'],
      ['draft_external', 'padre'],
      ['create_agent', 'padre'],
      ['delete_agent', 'padre'],
      ['propose_rule_change', 'padre']
    ]
    for (const [tool, why] of cases) {
      expect(subagentToolAllowed(tool), tool).toBe(false)
      const reason = subagentToolDenyReason(tool)
      expect(reason, tool).toBeTruthy()
      expect(reason!, tool).toContain(why)
    }
  })
  it('un tool sconosciuto al padre: rifiuto generico', () => {
    expect(subagentToolDenyReason('qualunque_altro')).toBe('disponibile solo al bot padre')
  })
})

describe('fase 12 (punto 2): validazione del brief e limiti', () => {
  it('brief mancante o sotto i 200 caratteri → errore chiaro', () => {
    expect(subagentBriefError('')).toBe('servono title e brief')
    expect(subagentBriefError('x'.repeat(199))).toBe(SHORT_BRIEF_ERROR)
    expect(subagentBriefError('x'.repeat(200))).toBeNull()
  })
  it('le costanti della specifica', () => {
    expect(MAX_SPAWNS_PER_TURN).toBe(4)
    expect(MAX_OPEN_SUBAGENTS).toBe(6)
    expect(WAKE_SUMMARY_MAX_CHARS).toBe(2000)
    expect(SUBAGENT_RECOVERY_NUDGE).toContain('wake_parent')
  })
})

describe('fase 12 (punto 3): subagentClosure, la chiusura robusta', () => {
  const base = { wakeCalled: false, nudged: false, freeText: '', modelError: false }
  it('wake_parent chiamato → niente da fare', () => {
    expect(subagentClosure({ ...base, wakeCalled: true })).toEqual({ kind: 'none' })
  })
  it('senza consegna e senza sollecito → NUDGE (una chiamata di recupero)', () => {
    expect(subagentClosure({ ...base })).toEqual({ kind: 'nudge' })
  })
  it('dopo il sollecito: testo libero → AUTO-DONE, vuoto → AUTO-FAILED', () => {
    expect(subagentClosure({ ...base, nudged: true, freeText: 'Astro è ottimo per i contenuti…' })).toEqual({ kind: 'auto-done' })
    expect(subagentClosure({ ...base, nudged: true, freeText: '   ' })).toEqual({ kind: 'auto-failed' })
  })
  it('errore del modello → AUTO-FAILED subito (niente sollecito su un modello muto)', () => {
    expect(subagentClosure({ ...base, modelError: true })).toEqual({ kind: 'auto-failed' })
  })
  it('i summary delle chiusure non consegnate: testo + nota; scadenza coi minuti', () => {
    expect(autoCloseSummary('risultato breve')).toBe(`risultato breve\n${AUTO_CLOSE_NOTE}`)
    expect(autoCloseSummary('')).toBe(AUTO_CLOSE_NOTE)
    expect(expiredSummary('', 20)).toBe('(scaduto dopo 20 minuti)')
    expect(expiredSummary('quasi finito', 20)).toBe('quasi finito\n(scaduto dopo 20 minuti)')
  })
})

// ---- correzione J4 (caso 21) + K2: i CONFINI nel brief e l'OBIETTIVO ----

import { briefTargets, briefTarget } from '../subagents'

describe('correzione K2: briefTarget — il titolo della spawn vince, altrimenti le menzioni uniche', () => {
  const FW = ['astro', 'sveltekit', 'remix']
  // il brief REALE del modello (abbreviato, stesse menzioni): "confronto
  // comparativo con" NON è un confine → astro 2, sveltekit 1, remix 1
  const BRIEF_ASTRO = [
    'Ricerca approfondita sul framework web Astro per un confronto comparativo con SvelteKit e Remix.',
    'OBIETTIVO: analizzi Astro: punti di forza, limiti principali e quando sceglierlo.',
    'Consegna un summary condensato e il report nel file indicato.'
  ].join('\n')
  // menzioni PARI (2/2/2): senza titolo che nomini un framework non c'è obiettivo
  const BRIEF_PARI = 'Confronto aperto: Astro e SvelteKit, Astro o SvelteKit, con Remix e Remix. Analizza e consegna.'

  it('il brief vero col "confronto comparativo con" → astro (dal titolo, e anche dalle menzioni 2/1/1)', () => {
    expect(briefTarget('Ricerca su Astro', BRIEF_ASTRO, FW)).toBe('astro')
    // anche senza framework nel titolo: le menzioni hanno massimo UNICO
    expect(briefTarget('Ricerca framework web', BRIEF_ASTRO, FW)).toBe('astro')
  })
  it('titolo "Ricerca su Remix" → remix ANCHE con le menzioni pari', () => {
    expect(briefTarget('Ricerca su Remix', BRIEF_PARI, FW)).toBe('remix')
  })
  it('titolo senza framework e menzioni pari → null (nessun obiettivo)', () => {
    expect(briefTarget('Ricerca framework web', BRIEF_PARI, FW)).toBeNull()
    // e nessuna menzione da nessuna parte → null
    expect(briefTarget('Ricerca', 'Analisi del gestore di contenuti headless più adatto.', FW)).toBeNull()
  })
})

describe('correzione J4: briefTargets — un brief "copre" un nome solo se lo dichiara OBIETTIVO', () => {
  // il brief del caso eval 24: obiettivo Astro, SvelteKit e Remix solo nei
  // CONFINI e nel CONFRONTO
  const CASE24_BRIEF = [
    'Ricerca approfondita sul framework web Astro.',
    'Obiettivo: punti di forza, limiti principali e quando sceglierlo rispetto a SvelteKit e Remix.',
    'Confini: NON cercare SvelteKit né Remix (li cerca un altro sottoagente).',
    'Formato: summary di massimo 10 righe col giudizio; il dettaglio va nel report.',
    'Dove salvare: subagents/sub_e24a/report.md (write-file).'
  ].join('\n')
  const FW = ['astro', 'sveltekit', 'remix']

  it('il brief del caso 24 (obiettivo Astro, confini SvelteKit e Remix) → ["astro"]', () => {
    expect(briefTargets(CASE24_BRIEF, FW)).toEqual(['astro'])
  })
  it('il brief SPORCO (nessun confine) copre TUTTI: il giudizio eval lo boccia', () => {
    expect(briefTargets('Ricerca su Astro, SvelteKit e Remix: confrontali e consegnami tutto.', FW))
      .toEqual(['astro', 'sveltekit', 'remix'])
  })
  it('confini in EN ("Do not cover…") non contano; la frase di CONFRONTO intera si salta', () => {
    expect(briefTargets('Deep dive on Remix. Do not cover Astro; another subagent does it.', ['astro', 'remix'])).toEqual(['remix'])
    // "Studia SvelteKit vs Astro" è tutta una frase di confronto: nessun obiettivo
    expect(briefTargets('Studia SvelteKit vs Astro per il confronto.', ['astro', 'sveltekit'])).toEqual([])
  })
  it('il nome conta solo a PAROLA INTERA (AstroMol non è Astro)', () => {
    expect(briefTargets('Ricerca su AstroMol, il gestore molecolare.', FW)).toEqual([])
  })
})
