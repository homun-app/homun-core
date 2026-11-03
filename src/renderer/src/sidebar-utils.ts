// Fase 16 (U4): filtro della ricerca della sidebar e anteprima dell'ultimo
// messaggio visibile. Funzioni pure, testate.
// Fase 17a (L3): le anteprime CON prefisso ("Tu: …", "Bozza per …") sono
// message descriptor (i prefissi si traducono, i contenuti no); le altre
// restano stringhe di dati.
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { Agent, GroupInfo, TranscriptEntry } from '../../shared/types'

/** L'anteprima della sidebar: testo di dati oppure un descriptor da tradurre. */
export type SidebarPreview = string | MessageDescriptor

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

// ---- fase 16b (S2): chi ti risponde — il modello della barra ----

/** Una squadra della barra: coordinatore in testa, membri sotto di lui. */
export interface SidebarTeam {
  group: GroupInfo
  coordinator: Agent | null
  /** i membri BOT senza il coordinatore, in ordine di ingresso */
  members: Agent[]
  /** un membro (coordinatore compreso) è in attesa dell'utente */
  waiting: boolean
  /** quanti membri aspettano l'utente (il contatore della barra stretta) */
  waitingCount: number
  /** l'attività recente: l'ultimo messaggio, o la creazione */
  lastAt: number
}

/** Un bot singolo della barra (né principale, né in squadra, né figlio). */
export interface SidebarBot {
  agent: Agent
  /** la sezione «progetto», se c'è */
  section: string | null
}

/** Il modello completo: principale, squadre (ordinate), bot singoli. */
export interface SidebarModel {
  main: Agent | null
  teams: SidebarTeam[]
  bots: SidebarBot[]
}

/**
 * buildSidebarModel (fase 16b, S2 — pura, testata): la regola è «chi ti
 * risponde sta in fila; chi lavora per lui sta sotto, rientrato». Restituisce
 * 1. il bot principale (mainAgentId, altrimenti il primo bot, come
 *    effectiveMain);
 * 2. le squadre, ordinate: prima quelle con qualcuno che ti aspetta, poi per
 *    attività recente; coordinator e membri risolti;
 * 3. i bot che non sono il principale, non stanno in nessuna squadra e non
 *    sono FIGLI (i sottoagenti non vanno mai in barra), con la loro sezione.
 * La ricerca filtra per nome di bot e di squadra: una squadra resta se il
 * nome della squadra, del coordinatore o di un membro combacia. Il principale
 * resta sempre visibile (è il punto d'ingresso).
 */
export function buildSidebarModel(
  agents: Agent[],
  groups: GroupInfo[],
  mainAgentId: string | null,
  query = ''
): SidebarModel {
  // i FIGLI (sottoagenti) non compaiono MAI nella barra
  const bots = agents.filter((a) => !a.parentId)
  const main = bots.find((a) => a.id === mainAgentId) ?? bots[0] ?? null

  const teams: SidebarTeam[] = []
  const inTeams = new Set<string>()
  for (const g of groups) {
    const resolved: Agent[] = []
    for (const m of g.members) {
      const a = bots.find((x) => x.id === m.agentId)
      if (a) resolved.push(a)
    }
    for (const a of resolved) inTeams.add(a.id)
    const coordinator = resolved.find((a) => a.id === g.coordinatorId) ?? null
    const members = resolved.filter((a) => a.id !== coordinator?.id)
    const waitingCount = resolved.filter((a) => a.status === 'paused-for-approval').length
    teams.push({
      group: g, coordinator, members,
      waiting: waitingCount > 0, waitingCount,
      lastAt: g.lastMessageAt ?? g.createdAt
    })
  }
  // prima le squadre con qualcuno che ti aspetta, poi per attività recente
  teams.sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.lastAt - a.lastAt)

  const free = bots.filter((a) => a.id !== main?.id && !inTeams.has(a.id))
  const botsOut: SidebarBot[] = free.map((agent) => ({ agent, section: agent.section || null }))

  const q = query.trim()
  if (!q) return { main, teams, bots: botsOut }
  return {
    main,
    teams: teams.filter(
      (t) =>
        matchesQuery(t.group.name, q) ||
        (t.coordinator !== null && matchesQuery(t.coordinator.name, q)) ||
        t.members.some((m) => matchesQuery(m.name, q))
    ),
    bots: botsOut.filter((b) => matchesQuery(b.agent.name, q))
  }
}

// ---- fase 16b (S2): la barra STRETTA — solo mascotte, in quest'ordine ----

/** Una voce della barra stretta: principale, squadra (grappolo) o bot. */
export interface CollapsedVoice {
  kind: 'main' | 'team' | 'bot'
  key: string
  name: string
  /** stato breve per tooltip e aria-label */
  status: 'waiting' | 'busy' | 'idle'
  /** il contatore nero: i non letti del bot, i membri che aspettano per la squadra */
  counter: number
}

const statusOf = (a: Agent): 'waiting' | 'busy' | 'idle' =>
  a.status === 'paused-for-approval' ? 'waiting'
    : a.status === 'thinking' || a.status === 'running' ? 'busy'
      : 'idle'

/**
 * Le voci della barra stretta, nello stesso ordine della barra larga:
 * principale, squadre, bot singoli. Pura — è ciò che il rendering mostra
 * (mascotte + tooltip + contatore), testata senza DOM.
 */
export function collapsedVoices(model: SidebarModel): CollapsedVoice[] {
  const out: CollapsedVoice[] = []
  if (model.main) {
    out.push({ kind: 'main', key: model.main.id, name: model.main.name, status: statusOf(model.main), counter: model.main.unread })
  }
  for (const t of model.teams) {
    out.push({
      kind: 'team',
      key: `g${t.group.id}`,
      name: t.group.name,
      status: t.waiting ? 'waiting' : t.coordinator ? statusOf(t.coordinator) : 'idle',
      counter: t.waitingCount
    })
  }
  for (const b of model.bots) {
    out.push({ kind: 'bot', key: b.agent.id, name: b.agent.name, status: statusOf(b.agent), counter: b.agent.unread })
  }
  return out
}

/**
 * Fase 16b correzioni (P3): una squadra della barra è APERTA di default (i
 * membri si vedono sotto il coordinatore — «chi lavora per lui sta sotto,
 * rientrato»). In localStorage si ricorda solo la CHIUSURA scelta
 * dall'utente ('0'); riaprire cancella il ricordo e si torna al default.
 * saved = ciò che restituisce localStorage per la squadra (null se assente).
 */
export function teamOpenState(saved: string | null): boolean {
  return saved !== '0'
}

/**
 * L'anteprima dell'ultimo messaggio visibile di un transcript: i send-message
 * (non trattenuti), i widget con la loro domanda, le bozze col destinatario e
 * i messaggi dell'utente (con "Tu:"). '' se non c'è niente di visibile.
 * M2 (fase 0.3.1001): una entry utente CON un qualsiasi initiator è un avvio
 * automatico (routine, rientro, risvegli) — non è "Tu:" e non si anteprime.
 */
export function previewOf(entries: TranscriptEntry[]): SidebarPreview {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind === 'send-message') {
      const meta = (e.meta ?? {}) as { held?: boolean; message?: { type?: string; prompt?: string; to?: string } }
      if (meta.held) continue
      if (meta.message?.type === 'widget') return meta.message.prompt ?? ''
      if (meta.message?.type === 'draft') return msg`Bozza per ${meta.message.to ?? '?'}`
      if (meta.message?.type === 'text') return e.content
      continue
    }
    if (e.kind === 'message' && e.role === 'user') {
      const initiator = (e.meta as { initiator?: string } | null)?.initiator
      if (initiator !== undefined && initiator !== '') continue
      return msg`Tu: ${e.content}`
    }
  }
  return ''
}
