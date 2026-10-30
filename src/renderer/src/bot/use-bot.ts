// Fase 16 (U3/U4): what serve alla UI per disegnare un bot e la sua mascotte:
// aspetto (scelto o predefinito), stato dalla tabella di botStateFor e testo
// di stato. Tutta la logica sta nelle funzioni pure (bot-state, avatar).
import { useStore } from '../store'
import { avatarOf } from '../../../shared/avatar'
import type { Agent, AgentAvatar } from '../../../shared/types'
import { botStateFor, botStatusText, isStreaming, type BotState } from './bot-state'

export interface BotInfo {
  agent: Agent
  avatar: AgentAvatar
  state: BotState
  dimmed: boolean
  statusText: string
}

export function useBotInfo(agentId: string | null | undefined): BotInfo | null {
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const activity = useStore((s) => s.activity[agentId ?? ''])
  const typingAgentId = useStore((s) => s.typingAgentId)
  const lastDeltaAt = useStore((s) => s.lastDeltaAt[agentId ?? ''])
  const turnEnd = useStore((s) => s.turnEnds[agentId ?? ''])
  const nowTick = useStore((s) => s.nowTick)
  const agent = agents.find((a) => a.id === agentId)
  if (!agent) return null
  // fase 7: senza setting mainAgentId il principale è il primo agente
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  // nowTick si muove solo quando il happy scade; altrimenti l'orologio è adesso
  const now = nowTick || Date.now()
  const input = {
    status: agent.status,
    streaming: isStreaming(lastDeltaAt, now),
    userTyping: typingAgentId === agentId,
    turnEnd: turnEnd ?? null,
    now
  }
  return {
    agent,
    avatar: avatarOf(agent, agents, effectiveMain),
    state: botStateFor(input),
    dimmed: agent.status === 'offline',
    statusText: botStatusText({ ...input, activityTool: activity?.tool ?? null })
  }
}
