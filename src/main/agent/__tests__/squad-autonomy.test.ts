// Q1 (fase squadra): le regole d'autonomia della squadra — PURA. Le tre
// colonne del disegno (tela E1UivWqEiuZqVjkkR9K5hx, tavola 3), l'insieme
// FISSO che nessuna autonomia, regola o revisore può togliere, e la scelta
// della squadra di una delega 1-a-1.
import { describe, expect, it } from 'vitest'
import {
  GROUP_AUTONOMIES,
  normalizeGroupAutonomy,
  DESIGN_FA_DA_SOLA,
  DESIGN_CHIEDE_SEMPRE,
  designRowVerdict,
  squadAlwaysAsks,
  delegationSquadId
} from '../squad-autonomy'

describe('Q1: i tre valori di groups.autonomy', () => {
  it('sono esattamente ask | box | box_review', () => {
    expect([...GROUP_AUTONOMIES].sort()).toEqual(['ask', 'box', 'box_review'])
  })

  it('normalizeGroupAutonomy: i tre valori passano, tutto il resto (compresi i DB vecchi con NULL) diventa box', () => {
    expect(normalizeGroupAutonomy('ask')).toBe('ask')
    expect(normalizeGroupAutonomy('box')).toBe('box')
    expect(normalizeGroupAutonomy('box_review')).toBe('box_review')
    expect(normalizeGroupAutonomy(null)).toBe('box')
    expect(normalizeGroupAutonomy(undefined)).toBe('box')
    expect(normalizeGroupAutonomy('libera')).toBe('box')
    expect(normalizeGroupAutonomy(42)).toBe('box')
  })
})

describe('Q1: le tre colonne del disegno, riga per riga, con ciascuna autonomia', () => {
  it('«Fa da sola» — nel computer (box): TUTTE le righe passano', () => {
    for (const row of DESIGN_FA_DA_SOLA) {
      if (row.id === 'file-outside-box' || row.id === 'commands-with-network' || row.id === 'talk-between-bots-contaminated') continue
      expect(designRowVerdict(row, 'box'), row.label).toBe('passa')
    }
  })

  it('«Fa da sola» — computer + revisore (box_review): le stesse righe passano', () => {
    for (const row of DESIGN_FA_DA_SOLA) {
      if (row.id === 'file-outside-box' || row.id === 'commands-with-network' || row.id === 'talk-between-bots-contaminated') continue
      expect(designRowVerdict(row, 'box_review'), row.label).toBe('passa')
    }
  })

  it('«Fa da sola» — chiede tutto (ask): file e comandi chiedono, il resto (già libero oggi) passa', () => {
    const v = Object.fromEntries(DESIGN_FA_DA_SOLA.map((r) => [r.id, designRowVerdict(r, 'ask')]))
    expect(v['file-in-computer']).toBe('chiede')
    expect(v['commands-no-network']).toBe('chiede')
    expect(v['web-pages']).toBe('passa')
    expect(v['talk-between-bots']).toBe('passa')
    expect(v['subagents']).toBe('passa')
    expect(v['documents']).toBe('passa')
  })

  it('i contorni della colonna: fuori dal box chiede, con la rete del box aperta run-command chiede', () => {
    expect(designRowVerdict(DESIGN_FA_DA_SOLA.find((r) => r.id === 'file-outside-box')!, 'box')).toBe('chiede')
    expect(designRowVerdict(DESIGN_FA_DA_SOLA.find((r) => r.id === 'file-outside-box')!, 'box_review')).toBe('chiede')
    expect(designRowVerdict(DESIGN_FA_DA_SOLA.find((r) => r.id === 'commands-with-network')!, 'box')).toBe('chiede')
    expect(designRowVerdict(DESIGN_FA_DA_SOLA.find((r) => r.id === 'commands-with-network')!, 'box_review')).toBe('chiede')
  })

  it('parlarsi CONTAMINATO: in box/box_review passa (la contaminazione va avanti), in ask chiede come oggi', () => {
    expect(designRowVerdict(DESIGN_FA_DA_SOLA.find((r) => r.id === 'talk-between-bots-contaminated')!, 'box')).toBe('passa')
    expect(designRowVerdict(DESIGN_FA_DA_SOLA.find((r) => r.id === 'talk-between-bots-contaminated')!, 'box_review')).toBe('passa')
    expect(designRowVerdict(DESIGN_FA_DA_SOLA.find((r) => r.id === 'talk-between-bots-contaminated')!, 'ask')).toBe('chiede')
  })

  it('«Chiede sempre a te» — l\'insieme FISSO chiede con OGNI autonomia', () => {
    for (const autonomy of GROUP_AUTONOMIES) {
      for (const row of DESIGN_CHIEDE_SEMPRE) {
        expect(designRowVerdict(row, autonomy), `${row.label} / ${autonomy}`).toBe('chiede')
      }
    }
  })

  it('l\'insieme fisso chiede ANCHE col revisore che direbbe sì (nessun revisore lo toglie)', () => {
    for (const row of DESIGN_CHIEDE_SEMPRE) {
      expect(designRowVerdict({ ...row, reviewerAllows: true }, 'box_review'), row.label).toBe('chiede')
    }
  })
})

describe('Q1: squadAlwaysAsks — l\'insieme fisso nel codice', () => {
  it('i tool dell\'insieme fisso chiedono sempre in un turno di squadra', () => {
    for (const tool of ['fill_credential', 'copy_to_box', 'copy_from_box', 'use-app', 'delete_agent', 'export_from_library']) {
      expect(squadAlwaysAsks(tool, {}, {}), tool).toBe(true)
    }
  })

  it('update_agent chiede solo sul bot DI UN ALTRO: sul proprio passa', () => {
    expect(squadAlwaysAsks('update_agent', { agentId: 'agent_b' }, { callerAgentId: 'agent_a', createdByOf: (id) => (id === 'agent_b' ? 'qualcun-altro' : 'agent_a') })).toBe(true)
    expect(squadAlwaysAsks('update_agent', { agentId: 'agent_a' }, { callerAgentId: 'agent_a', createdByOf: (id) => (id === 'agent_a' ? 'agent_a' : 'altro') })).toBe(false)
  })

  it('i pagamenti chiedono: un clic con parole di pagamento è fisso, un clic normale no', () => {
    expect(squadAlwaysAsks('browser_click', { ref: 'e5' }, { browserAsk: { kind: 'commit', name: 'Paga ora' } })).toBe(true)
    expect(squadAlwaysAsks('browser_click', { ref: 'e5' }, { browserAsk: { kind: 'commit', name: 'Cerca' } })).toBe(false)
    expect(squadAlwaysAsks('browser_click', { ref: 'e5' }, { browserAsk: { kind: 'probe', name: 'Nome' } })).toBe(false)
  })

  it('quello che NON è nell\'insieme non chiede per il solo fatto di esserci', () => {
    expect(squadAlwaysAsks('write-file', { path: '/workspace/x.md' }, {})).toBe(false)
    expect(squadAlwaysAsks('run-command', { command: 'ls' }, {})).toBe(false)
    expect(squadAlwaysAsks('web_fetch', { url: 'https://x' }, {})).toBe(false)
    expect(squadAlwaysAsks('write_document', { title: 'x' }, {})).toBe(false)
    expect(squadAlwaysAsks('spawn_subagent', { title: 'x', brief: 'y'.repeat(200) }, {})).toBe(false)
    expect(squadAlwaysAsks('send_to_agent', { agentId: 'b', text: 'ciao' }, {})).toBe(false)
  })
})

describe('Q1: delegationSquadId — la squadra di una delega 1-a-1', () => {
  it('il turno del mittente è di squadra ed entrambi ne sono membri → quella squadra', () => {
    expect(delegationSquadId(7, [7, 9], [7, 3])).toBe(7)
  })

  it('senza squadra nel turno, ma UNA sola in comune → quella', () => {
    expect(delegationSquadId(null, [7, 9], [9, 3])).toBe(9)
  })

  it('più squadre in comune e nessuna nel turno → nessuna (valgono le impostazioni globali)', () => {
    expect(delegationSquadId(null, [7, 9], [7, 9])).toBeNull()
  })

  it('nessuna in comune → nessuna', () => {
    expect(delegationSquadId(7, [7], [3])).toBeNull()
    expect(delegationSquadId(null, [7], [3])).toBeNull()
  })
})
