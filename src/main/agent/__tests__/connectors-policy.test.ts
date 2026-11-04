// Test PURI della policy del punto 3 (fase 13): add_mcp_server e
// install_plugin sono offerti SOLO nei turni nati da un messaggio diretto
// dell'utente in chat — regola 9 dell'onboarding di Grok, in CODICE.
import { describe, expect, it } from 'vitest'
import { connectorProposalOffered, toolsForTurnSource, CONNECTOR_PROPOSAL_DENIED, CONNECTOR_PROPOSAL_TOOLS } from '../connectors-policy'
import { toolDefs } from '../tools'

const base = { source: 'user' as const }

describe('connectorProposalOffered (pura)', () => {
  it('true SOLO nel turno dell\'utente diretto in chat', () => {
    expect(connectorProposalOffered({ ...base })).toBe(true)
  })
  it('fuori: routine, gruppo, task-run, figli, catene e initiator di sistema', () => {
    expect(connectorProposalOffered({ source: 'routine' })).toBe(false)
    expect(connectorProposalOffered({ ...base, groupTurn: { groupId: 1, readMaxDepth: 0, rootId: null } })).toBe(false)
    expect(connectorProposalOffered({ ...base, subagent: { id: 'sub_x', parentId: 'p' } })).toBe(false)
    expect(connectorProposalOffered({ ...base, taskId: 3 })).toBe(false)
    expect(connectorProposalOffered({ ...base, automatic: true })).toBe(false)
    expect(connectorProposalOffered({ ...base, agentMessage: { fromAgentId: 'a', fromAgentName: 'A', hop: 1 } })).toBe(false)
    expect(connectorProposalOffered({ ...base, initiator: 'SUBAGENTS_DONE' })).toBe(false)
    expect(connectorProposalOffered({ ...base, initiator: 'SHELL_DONE' })).toBe(false)
    expect(connectorProposalOffered({ ...base, initiator: 'CONNECTOR_CONNECTED' })).toBe(false)
    expect(connectorProposalOffered({ ...base, initiator: 'LOOK_AROUND' })).toBe(false)
  })
})

describe('toolsForTurnSource (pura): la lista dei tool per sorgente di turno', () => {
  const has = (tools: ReturnType<typeof toolsForTurnSource>): boolean =>
    tools.some((t) => CONNECTOR_PROPOSAL_TOOLS.has(t.name))

  it('i due tool sono nelle definizioni e nel turno utente ci RESTANO', () => {
    expect(toolDefs.some((t) => t.name === 'add_mcp_server')).toBe(true)
    expect(toolDefs.some((t) => t.name === 'install_plugin')).toBe(true)
    expect(has(toolsForTurnSource(toolDefs, { ...base }))).toBe(true)
  })
  it('assenti nei turni di routine, gruppo e figlio', () => {
    expect(has(toolsForTurnSource(toolDefs, { source: 'routine' }))).toBe(false)
    expect(has(toolsForTurnSource(toolDefs, { ...base, groupTurn: { groupId: 1, readMaxDepth: 0, rootId: null } }))).toBe(false)
    expect(has(toolsForTurnSource(toolDefs, { ...base, subagent: { id: 'sub_x', parentId: 'p' } }))).toBe(false)
    expect(has(toolsForTurnSource(toolDefs, { ...base, taskId: 2 }))).toBe(false)
    expect(has(toolsForTurnSource(toolDefs, { ...base, initiator: 'SUBAGENTS_DONE' }))).toBe(false)
    expect(has(toolsForTurnSource(toolDefs, { ...base, initiator: 'SHELL_DONE' }))).toBe(false)
  })
  it('gli ALTRI tool restano (si tolgono solo i due di proposta, più la coppia R2)', () => {
    // fase risposta (R2): fuori dai gruppi si offre message_user e NON
    // send_to_user; nei gruppi il contrario. Il resto resta.
    const kept = toolsForTurnSource(toolDefs, { source: 'routine' })
    expect(kept.some((t) => t.name === 'message_user')).toBe(true)
    expect(kept.some((t) => t.name === 'send_to_user')).toBe(false)
    expect(kept.some((t) => t.name === 'search_connectors')).toBe(true)
    expect(kept.length).toBe(
      toolDefs.filter((t) => !CONNECTOR_PROPOSAL_TOOLS.has(t.name) && t.name !== 'send_to_user').length
    )
  })

  it('fase risposta (R2): nei turni di GRUPPO resta send_to_user, mai message_user', () => {
    const group = toolsForTurnSource(toolDefs, { ...base, groupTurn: { groupId: 1, readMaxDepth: 0, rootId: null } })
    expect(group.some((t) => t.name === 'send_to_user')).toBe(true)
    expect(group.some((t) => t.name === 'message_user')).toBe(false)
    const plain = toolsForTurnSource(toolDefs, base)
    expect(plain.some((t) => t.name === 'message_user')).toBe(true)
    expect(plain.some((t) => t.name === 'send_to_user')).toBe(false)
  })
  it('il testo del rifiuto è quello della specifica', () => {
    expect(CONNECTOR_PROPOSAL_DENIED).toBe('you may propose connectors only when the user asks you in chat')
  })
})
