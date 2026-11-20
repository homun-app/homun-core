// Fase 16 (U4): filtro della ricerca della sidebar e anteprima dell'ultimo
// messaggio visibile. Funzioni pure, testate.
// Fase 17a (L3): le anteprime CON prefisso ("Tu: …", "Bozza per …") sono
// message descriptor (i prefissi si traducono, i contenuti no); le altre
// restano stringhe di dati.
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { Agent, GroupInfo, TranscriptEntry } from '../../shared/types'
import type { BotState } from './bot/bot-state'

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
  /**
   * R1/R2 (fase barra-sobria): lo stato AGGREGATO della squadra — l'ordine
   * della priorità è «aspetta te» > «lavora» > «finito» > «fermo».
   */
  state: RowState
}

/** Un bot singolo della barra (né principale, né in squadra, né figlio). */
export interface SidebarBot {
  agent: Agent
  /** la sezione «progetto», se c'è */
  section: string | null
  /**
   * AH2 (fase aiutanti): un FIGLIO di questo bot ha una card aperta — la
   * barra lo segna «ti aspetta» anche se il suo turno è finito.
   */
  childWaiting: boolean
  /** R1 (fase barra-sobria): la riga lo mostra col pallino, non più con la mascotte */
  waiting: boolean
  /** lo stato della mascotte, per il segno a destra (R2) e l'ordinamento */
  state: BotState
  /** l'ultima attività: lastSendAt, o la creazione (per «4m», «1g») */
  lastAt: number | null
}

/** Il modello completo: principale, squadre (ordinate), bot singoli. */
export interface SidebarModel {
  main: Agent | null
  /** AH2 (fase aiutanti): anche il principale può avere un figlio che aspetta */
  mainWaiting: boolean
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
  query = '',
  /** AH2 (fase aiutanti): bot con un FIGLIO fermo su una card («ti aspetta») */
  waitingOnChildren: ReadonlySet<string> = new Set(),
  /**
   * R1 (fase barra-sobria): gli stati della mascotte e i tempi dell'ultima
   * attività, già risolti da chi chiama (botStateFor/lastSendAt dello store).
   * Senza opzioni si torna alla sola lettura dello status, come prima.
   */
  opts: { states?: Readonly<Record<string, BotState>>; lastSendAt?: Readonly<Record<string, number>> } = {}
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
      lastAt: g.lastMessageAt ?? g.createdAt,
      state: teamRowState(resolved.map((a) => stateOfAgent(a, opts.states)))
    })
  }
  // prima le squadre con qualcuno che ti aspetta, poi per attività recente
  teams.sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.lastAt - a.lastAt)

  const free = bots.filter((a) => a.id !== main?.id && !inTeams.has(a.id))
  const botsOut: SidebarBot[] = free.map((agent) => {
    const state = stateOfAgent(agent, opts.states)
    return {
      agent,
      section: agent.section || null,
      childWaiting: waitingOnChildren.has(agent.id),
      state,
      waiting: waitingOnChildren.has(agent.id) || state === 'waiting',
      lastAt: opts.lastSendAt?.[agent.id] ?? agent.createdAt
    }
  })

  const q = query.trim()
  const mainWaiting = main !== null && waitingOnChildren.has(main.id)
  if (!q) return { main, mainWaiting, teams, bots: botsOut }
  return {
    main,
    mainWaiting,
    teams: teams.filter(
      (t) =>
        matchesQuery(t.group.name, q) ||
        (t.coordinator !== null && matchesQuery(t.coordinator.name, q)) ||
        t.members.some((m) => matchesQuery(m.name, q))
    ),
    bots: botsOut.filter((b) => matchesQuery(b.agent.name, q))
  }
}

// ---- fase barra-sobria (R1): la barra per molti progetti (tavola 6) ----

/**
 * Lo stato della riga, PRESO DALLA MASCOTTE (R2): le animazioni sono quelle
 * che la mascotte usa già in styles.css — qui solo il nome del segno.
 */
export type RowState = 'lavora' | 'aspetta-te' | 'finito' | 'fermo'

/** Quante righe si vedono di ogni sezione prima di «Mostra tutti (N)». */
export const SIDEBAR_ROW_LIMIT = 4

/** Quanti membri di una squadra aperta prima di «Altri N». */
export const TEAM_MEMBER_LIMIT = 2

/** lo stato della riga dallo stato della mascotte (childWaiting: AH2). */
export function rowStateOf(state: BotState, childWaiting = false): RowState {
  if (childWaiting || state === 'waiting') return 'aspetta-te'
  if (state === 'thinking' || state === 'speaking' || state === 'listening') return 'lavora'
  if (state === 'happy') return 'finito'
  return 'fermo'
}

/** lo stato aggregato della squadra: aspetta te > lavora > finito > fermo. */
export function teamRowState(states: BotState[]): RowState {
  if (states.some((s) => s === 'waiting')) return 'aspetta-te'
  if (states.some((s) => s === 'thinking' || s === 'speaking' || s === 'listening')) return 'lavora'
  if (states.some((s) => s === 'happy')) return 'finito'
  return 'fermo'
}

/** lo stato di un agente: dalla mappa risolta, o dal solo status come prima. */
function stateOfAgent(a: Agent, states?: Readonly<Record<string, BotState>>): BotState {
  const s = states?.[a.id]
  if (s) return s
  if (a.status === 'paused-for-approval') return 'waiting'
  if (a.status === 'thinking') return 'thinking'
  if (a.status === 'running') return 'listening'
  return 'idle'
}

/** L'ordine dentro ogni sezione: prima chi aspetta te, poi ultima attività. */
export function orderRows<T extends { waiting: boolean; lastAt: number | null }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => Number(b.waiting) - Number(a.waiting) || (b.lastAt ?? -Infinity) - (a.lastAt ?? -Infinity)
  )
}

/** Il taglio a SIDEBAR_ROW_LIMIT con «Mostra tutti (N)». */
export function cutRows<T>(rows: T[], expanded: boolean): { visible: T[]; hidden: number } {
  if (expanded || rows.length <= SIDEBAR_ROW_LIMIT) return { visible: rows, hidden: 0 }
  return { visible: rows.slice(0, SIDEBAR_ROW_LIMIT), hidden: rows.length - SIDEBAR_ROW_LIMIT }
}

/** I membri della squadra aperta: al massimo TEAM_MEMBER_LIMIT più «Altri N». */
export function memberCut<T>(rows: T[], expanded: boolean): { visible: T[]; hidden: number } {
  if (expanded || rows.length <= TEAM_MEMBER_LIMIT) return { visible: rows, hidden: 0 }
  return { visible: rows.slice(0, TEAM_MEMBER_LIMIT), hidden: rows.length - TEAM_MEMBER_LIMIT }
}

/** Le squadre che si aprono DA SOLE: solo quella attiva o quella che aspetta te. */
export function teamAutoOpens(team: Pick<SidebarTeam, 'waiting'> & { group: { id: number } }, activeGroupId: number | null): boolean {
  return team.waiting || team.group.id === activeGroupId
}

/**
 * Il tempo dell'ultima attività, corto come nella tavola: «adesso», «4m»,
 * «2h», «1g». at null (mai usato) → «mai».
 */
export function timeAgoShort(at: number | null, now: number): MessageDescriptor {
  if (at == null) return msg`mai`
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return msg`adesso`
  const m = Math.floor(s / 60)
  if (m < 60) return msg`${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return msg`${h}h`
  const g = Math.floor(h / 24)
  return msg`${g}g`
}

// ---- fase 16b (S2): la barra STRETTA — solo mascotte, in quest'ordine ----

/** Una voce della barra stretta: principale, squadra (grappolo) o bot. */
export interface CollapsedVoice {
  kind: 'main' | 'team' | 'bot'
  key: string
  name: string
  /** R2 (fase barra-sobria): lo stato della riga, preso dalla mascotte */
  status: RowState
  /** il contatore nero: i non letti del bot, i membri che aspettano per la squadra */
  counter: number
}

/**
 * Le voci della barra stretta, nello stesso ordine della barra larga:
 * principale, squadre, bot singoli. Pura — è ciò che il rendering mostra
 * (mascotte + tooltip + contatore), testata senza DOM.
 */
export function collapsedVoices(model: SidebarModel): CollapsedVoice[] {
  const out: CollapsedVoice[] = []
  if (model.main) {
    // AH2: un figlio che aspetta segna «ti aspetta» anche il principale
    out.push({
      kind: 'main',
      key: model.main.id,
      name: model.main.name,
      status: rowStateOf(stateOfAgent(model.main), model.mainWaiting),
      counter: model.main.unread
    })
  }
  for (const t of model.teams) {
    out.push({
      kind: 'team',
      key: `g${t.group.id}`,
      name: t.group.name,
      status: t.state,
      counter: t.waitingCount
    })
  }
  for (const b of model.bots) {
    out.push({
      kind: 'bot',
      key: b.agent.id,
      name: b.agent.name,
      status: rowStateOf(b.state, b.childWaiting),
      counter: b.agent.unread
    })
  }
  return out
}

/**
 * Fase barra-sobria (R1): una squadra della barra è CHIUSA di default — si
 * apre da sola SOLO la squadra attiva o quella che aspetta te (auto, da
 * teamAutoOpens). L'utente comanda col suo stato salvato in localStorage
 * ('1' = aperta, '0' = chiusa); senza scelta conta l'auto. Prima (fase 16b
 * correzioni P3) erano aperte di default e si ricordava solo la chiusura.
 */
export function teamOpenState(saved: string | null, auto: boolean): boolean {
  if (saved === '1') return true
  if (saved === '0') return false
  return auto
}

/**
 * B3 (fase beta.4): l'anteprima della barra è TESTO SEMPLICE — niente **, _,
 * #, backtick o link markdown (l'anteprima mostrava «Fatto! Ho creato il bot
 * **"No…»). I link diventano il loro testo. PURO.
 */
export function plainPreview(text: string): string {
  return text
    // [testo](url) → testo
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // **grassetto** e __grassetto__
    .replace(/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/g, '$2')
    // *corsivo* e _corsivo_ (non dentro le parole: snake_case resta suo)
    .replace(/(^|[^\w*_])[*_](?=\S)([^*_\n]+?)(?<=\S)[*_](?!\w)/g, '$1$2')
    // `codice` e ```codice```
    .replace(/`{1,3}([^`\n]*)`{1,3}/g, '$1')
    // i titoli #
    .replace(/^#{1,6}[ \t]+/gm, '')
    .trim()
}

/**
 * L'anteprima dell'ultimo messaggio visibile di un transcript: i send-message
 * (non trattenuti), i widget con la loro domanda, le bozze col destinatario e
 * i messaggi dell'utente (con "Tu:"). '' se non c'è niente di visibile.
 * M2 (fase 0.3.1001): una entry utente CON un qualsiasi initiator è un avvio
 * automatico (routine, rientro, risvegli) — non è "Tu:" e non si anteprime.
 * B3 (fase beta.4): nemmeno la risposta a una domanda (respondedTo) si
 * anteprime — vive nella riga della card; e i testi sono SEMPLICI.
 */
export function previewOf(entries: TranscriptEntry[]): SidebarPreview {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind === 'send-message') {
      const meta = (e.meta ?? {}) as { held?: boolean; message?: { type?: string; prompt?: string; to?: string } }
      if (meta.held) continue
      if (meta.message?.type === 'widget') return plainPreview(meta.message.prompt ?? '')
      if (meta.message?.type === 'draft') return msg`Bozza per ${meta.message.to ?? '?'}`
      if (meta.message?.type === 'text') return plainPreview(e.content)
      continue
    }
    if (e.kind === 'message' && e.role === 'user') {
      const meta = (e.meta ?? {}) as { initiator?: string; respondedTo?: number }
      if (meta.initiator !== undefined && meta.initiator !== '') continue
      // B3: la risposta a una domanda sta già nella riga della card
      if (meta.respondedTo !== undefined) continue
      return msg`Tu: ${plainPreview(e.content)}`
    }
  }
  return ''
}
