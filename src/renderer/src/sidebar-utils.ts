// Fase 16 (U4): filtro della ricerca della sidebar e anteprima dell'ultimo
// messaggio visibile. Funzioni pure, testate.
import type { Agent, GroupInfo, TranscriptEntry } from '../../shared/types'

/**
 * La query della ricerca: maiuscole/minuscole irrilevanti, gli spazi separano
 * parole che devono esserci TUTTE (and), la stringa vuota matcha tutto.
 */
export function matchesQuery(name: string, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const n = name.toLowerCase()
  return tokens.every((t) => n.includes(t))
}

/** La lista dei bot e dei gruppi che passano la ricerca per nome. */
export function filterSidebar(agents: Agent[], groups: GroupInfo[], query: string): { agents: Agent[]; groups: GroupInfo[] } {
  if (!query.trim()) return { agents, groups }
  return {
    agents: agents.filter((a) => matchesQuery(a.name, query)),
    groups: groups.filter((g) => matchesQuery(g.name, query))
  }
}

/**
 * L'anteprima dell'ultimo messaggio visibile di un transcript: i send-message
 * (non trattenuti), i widget con la loro domanda, le bozze col destinatario e
 * i messaggi dell'utente (con "Tu:"). '' se non c'è niente di visibile.
 */
export function previewOf(entries: TranscriptEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind === 'send-message') {
      const meta = (e.meta ?? {}) as { held?: boolean; message?: { type?: string; prompt?: string; to?: string } }
      if (meta.held) continue
      if (meta.message?.type === 'widget') return meta.message.prompt ?? ''
      if (meta.message?.type === 'draft') return `Bozza per ${meta.message.to ?? '?'}`
      if (meta.message?.type === 'text') return e.content
      continue
    }
    if (e.kind === 'message' && e.role === 'user') {
      const initiator = (e.meta as { initiator?: string } | null)?.initiator
      if (initiator === 'AGENT' || initiator === 'TEMPLATE_IMPORT' || initiator === 'TASK_DONE') continue
      return `Tu: ${e.content}`
    }
  }
  return ''
}
