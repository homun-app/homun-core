// Fase 16 (U2): l'aspetto predefinito dei bot. Funzioni pure, senza DOM né
// database — le usa il renderer per disegnare e il daemon per validare.
import type { Agent, AgentAvatar, BotColor, BotFamily } from './types'

export const BOT_FAMILIES: readonly BotFamily[] = ['h-creature', 'h-robo', 'h-device', 'jelly', 'pixel']
export const BOT_COLORS: readonly BotColor[] = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']

/** Hash FNV-1a a 32 bit (stabile, veloce, niente dipendenze). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // >>> 0 per un intero senza segno costante su ogni motore
  return h >>> 0
}

/**
 * L'aspetto PREDEFINITO di un bot: il principale è Creatura c1; gli altri
 * ricevono famiglia e colore da un hash stabile dell'id, così un bot creato
 * da un altro bot ha subito un aspetto suo e lo mantiene tra sessioni e
 * riavvii (NULL nella colonna avatar = si ricalcola sempre uguale).
 */
export function defaultAvatar(agentId: string, isMain: boolean): AgentAvatar {
  if (isMain) return { family: 'h-creature', color: 'c1' }
  const h = fnv1a(agentId)
  return {
    family: BOT_FAMILIES[h % BOT_FAMILIES.length]!,
    color: BOT_COLORS[(h >>> 8) % BOT_COLORS.length]!
  }
}

/**
 * Validazione dell'avatar per agents:update (la fa il daemon, mai solo la
 * UI): null torna al predefinito; una famiglia fuori dalle 5 o un colore
 * fuori c1–c7 sono un errore. null se il valore è accettabile, il messaggio
 * d'errore altrimenti.
 */
export function avatarValidationError(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'object') return 'avatar non valido: atteso { family, color } o null'
  const a = v as { family?: unknown; color?: unknown }
  if (!BOT_FAMILIES.includes(a.family as BotFamily)) {
    return `avatar non valido: famiglia "${String(a.family)}" (le 5 possibili: ${BOT_FAMILIES.join(', ')})`
  }
  if (!BOT_COLORS.includes(a.color as BotColor)) {
    return `avatar non valido: colore "${String(a.color)}" (possibili: ${BOT_COLORS.join(', ')})`
  }
  return null
}

/**
 * L'aspetto con cui si DISEGNA un agente: quello scelto dall'utente, o il
 * predefinito da hash dell'id; i sottoagenti (righe con parentId) usano
 * l'aspetto del padre.
 */
export function avatarOf(agent: Agent, agents: Agent[], mainAgentId: string | null): AgentAvatar {
  if (agent.parentId) {
    const father = agents.find((a) => a.id === agent.parentId)
    if (father) return avatarOf(father, agents, mainAgentId)
  }
  if (agent.avatar) return agent.avatar
  return defaultAvatar(agent.id, mainAgentId === agent.id)
}
