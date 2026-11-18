// Q2 (fase squadra): la coda delle approvazioni della squadra — categorie,
// perché chiede, il grant di missione e i contatori di «Fatto da soli».
// PURA sulle righe; la raccolta dallo store vero sta in squad-pending.test.ts.
import { describe, expect, it } from 'vitest'
import {
  squadApprovalCategory,
  squadApprovalWhy,
  missionGrantAllowed,
  collectPendingApprovals,
  squadActivityCounters,
  MISSION_GRANT_MS
} from '../squad-approvals'

const card = (tool: string, meta: Record<string, unknown> = {}): { kind: string; content: string; meta: Record<string, unknown> } => ({
  kind: 'approval',
  content: 'frase della card',
  meta: { tool, status: 'pending', approvalId: 'x', input: {}, ...meta }
})

describe('Q2: le categorie della coda (tavola 2)', () => {
  it('dati-tuoi: fill_credential e browser_type sui campi con i dati dell\'utente', () => {
    expect(squadApprovalCategory(card('fill_credential'))).toBe('dati-tuoi')
    expect(squadApprovalCategory(card('browser_type', { browserAsk: { kind: 'probe', name: 'Nome' } }))).toBe('dati-tuoi')
  })

  it('pagamento: il clic di conferma con parole di pagamento', () => {
    expect(squadApprovalCategory(card('browser_click', { browserAsk: { kind: 'commit', name: 'Paga ora' } }))).toBe('pagamento')
    expect(squadApprovalCategory(card('browser_click', { browserAsk: { kind: 'commit', name: 'Buy now' } }))).toBe('pagamento')
  })

  it('sito-interattivo: gli altri clic e le azioni del browser', () => {
    expect(squadApprovalCategory(card('browser_click', { browserAsk: { kind: 'commit', name: 'Cerca' } }))).toBe('sito-interattivo')
    expect(squadApprovalCategory(card('browser_click', {}))).toBe('sito-interattivo')
    expect(squadApprovalCategory(card('browser_press_key', {}))).toBe('sito-interattivo')
  })

  it('invio: bozze esterne e strumenti MCP/Composio verso fuori', () => {
    expect(squadApprovalCategory(card('draft_external'))).toBe('invio')
    expect(squadApprovalCategory(card('mcp__gmail__send'))).toBe('invio')
    expect(squadApprovalCategory(card('composio__gmail__SEND_EMAIL'))).toBe('invio')
  })

  it('mac: use-app, scambio file col Mac, comandi e scritture fuori dal computer', () => {
    for (const tool of ['use-app', 'copy_to_box', 'copy_from_box', 'export_from_library', 'run-command', 'write-file']) {
      expect(squadApprovalCategory(card(tool)), tool).toBe('mac')
    }
  })

  it('squadra: messaggi tra bot e gestione della squadra', () => {
    for (const tool of ['send_to_agent', 'create_agent', 'create_group', 'update_group', 'update_agent', 'delete_agent']) {
      expect(squadApprovalCategory(card(tool)), tool).toBe('squadra')
    }
  })

  it('altro: tutto il resto', () => {
    expect(squadApprovalCategory(card('update_state'))).toBe('altro')
  })
})

describe('Q2: perché chiede', () => {
  it('i marcatori del loop: insieme fisso, revisore in dubbio, contaminato', () => {
    expect(squadApprovalWhy({ squadAlwaysAsk: true })).toBe('fisso')
    expect(squadApprovalWhy({ squadReviewerAsk: true })).toBe('revisore')
    expect(squadApprovalWhy({ contaminated: true })).toBe('contaminato')
    expect(squadApprovalWhy({})).toBeNull()
  })
})

describe('Q2: «Consenti per questa missione»', () => {
  it('esiste SOLO per sito-interattivo e squadra', () => {
    expect(missionGrantAllowed('sito-interattivo')).toBe(true)
    expect(missionGrantAllowed('squadra')).toBe(true)
    expect(missionGrantAllowed('dati-tuoi')).toBe(false)
    expect(missionGrantAllowed('pagamento')).toBe(false)
    expect(missionGrantAllowed('invio')).toBe(false)
    expect(missionGrantAllowed('mac')).toBe(false)
    expect(missionGrantAllowed('altro')).toBe(false)
  })

  it('la missione dura 8 ore', () => {
    expect(MISSION_GRANT_MS).toBe(8 * 60 * 60 * 1000)
  })
})

describe('Q2: collectPendingApprovals — membri e sottoagenti', () => {
  const entry = (over: Record<string, unknown>) => over as never
  it('raccoglie le pendenti dei membri E dei figli, escluse le decise, dalla più recente', () => {
    const entries: Record<string, Array<Record<string, unknown>>> = {
      capo: [
        entry({ kind: 'approval', content: 'card capo', createdAt: 100, meta: { tool: 'send_to_agent', status: 'pending', approvalId: 'a1' } }),
        entry({ kind: 'approval', content: 'vecchia', createdAt: 50, meta: { tool: 'use-app', status: 'allowed', approvalId: 'a0' } })
      ],
      figlio: [
        entry({ kind: 'send-message', content: 'card figlio', createdAt: 200, meta: { tool: 'fill_credential', status: 'pending', approvalId: 'a2' } })
      ]
    }
    const rows = collectPendingApprovals(
      [{ agentId: 'capo', name: 'Capo' }],
      (id) => (entries[id] ?? []) as never,
      (memberId) => (memberId === 'capo' ? [{ id: 'figlio', name: 'Figlio' }] : [])
    )
    expect(rows.map((r) => r.approvalId)).toEqual(['a2', 'a1'])
    expect(rows[0]!.fromSubagent).toBe(true)
    expect(rows[0]!.agentName).toBe('Figlio')
    expect(rows[1]!.category).toBe('squadra')
    expect(rows[0]!.category).toBe('dati-tuoi')
    expect(rows.every((r) => r.phrase.length > 0)).toBe(true)
  })
})

describe('Q2: i contatori di «Fatto da soli, senza chiederti»', () => {
  it('conta file, comandi e pagine dei turni della squadra, e i messaggi dei bot nel gruppo', () => {
    const toolCall = (name: string, squadId?: number) => ({
      kind: 'tool-call', content: name, createdAt: 1,
      meta: { name, ...(squadId !== undefined ? { squadId } : {}) }
    }) as never
    const entriesByAgent = [
      { agentId: 'a', name: 'Treni', entries: [toolCall('write-file', 7), toolCall('write-file', 7), toolCall('web_fetch', 7), toolCall('write-file', 9)] as never },
      { agentId: 'b', name: 'Capo', entries: [toolCall('run-command', 7), toolCall('web_fetch', 7)] as never }
    ]
    const msgs = [
      { author_kind: 'agent', author_id: 'a' },
      { author_kind: 'agent', author_id: 'b' },
      { author_kind: 'user', author_id: null },
      { author_kind: 'system', author_id: null }
    ]
    const counters = squadActivityCounters(entriesByAgent, msgs, 7)
    const byId = Object.fromEntries(counters.map((c) => [c.id, c]))
    expect(byId.files.count).toBe(2) // il write-file del gruppo 9 non conta
    expect(byId.files.who).toEqual(['Treni'])
    expect(byId.commands.count).toBe(1)
    expect(byId.commands.who).toEqual(['Capo'])
    expect(byId.pages.count).toBe(2)
    expect(byId.pages.who).toEqual(['Capo', 'Treni'])
    expect(byId['bot-messages'].count).toBe(2)
  })
})
