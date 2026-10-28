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
