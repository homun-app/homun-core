// Q2 (fase squadra): la coda delle approvazioni della squadra — logica PURA
// (con lo store iniettato dai chiamanti). Categorie leggibili, perché una
// card chiede, il grant «per questa missione» (solo sito-interattivo e
// squadra, 8 ore, un grant per membro) e i contatori di «Fatto da soli».
import type { TranscriptEntry } from '../../shared/types'
import { targetKey } from './permission-rules'

/** Le categorie della coda, come nella tavola 2 del disegno. */
export type SquadApprovalCategory = 'dati-tuoi' | 'pagamento' | 'invio' | 'sito-interattivo' | 'mac' | 'squadra' | 'altro'

/** Il perché una card chiede (tavola 2: contaminato, revisore in dubbio, insieme fisso). */
export type SquadApprovalWhy = 'contaminato' | 'revisore' | 'fisso' | null

/**
 * La categoria di una card pendente (pura, dal meta dell'entry). L'ordine dei
 * controlli conta: i pagamenti del browser prima del generico sito
 * interattivo, i dati tuoi prima di tutto ciò che compilerbebbe forme.
 */
export function squadApprovalCategory(entry: {
  kind: string
  content?: string
  meta?: Record<string, unknown> | null
}): SquadApprovalCategory {
  const meta = (entry.meta ?? {}) as Record<string, unknown>
  const tool = String(meta.tool ?? '')
  const input = (meta.input ?? {}) as Record<string, unknown>
  const browserAsk = (meta.browserAsk ?? null) as { kind?: string; name?: string } | null
  if (tool === 'fill_credential' || tool === 'save_contact') return 'dati-tuoi'
  if (tool === 'browser_type' && (browserAsk?.kind === 'probe')) return 'dati-tuoi'
  // i pagamenti del browser: il clic di conferma con parole di pagamento
  if ((tool === 'browser_click' || tool === 'browser_type' || tool === 'browser_select' || tool === 'browser_press_key') &&
      (browserAsk?.kind === 'commit') && paymentWordsIn(browserAsk?.name ?? '')) {
    return 'pagamento'
  }
  if (tool === 'draft_external' || tool.startsWith('mcp__') || tool.startsWith('composio__')) return 'invio'
  if (tool.startsWith('browser_')) return 'sito-interattivo'
  if (tool === 'use-app' || tool === 'copy_to_box' || tool === 'copy_from_box' || tool === 'export_from_library') return 'mac'
  if (tool === 'run-command' || tool === 'write-file') {
    // dentro il computer non chiede (autonomia): se chiede, è sul Mac o con la rete
    return 'mac'
  }
  if (tool === 'send_to_agent' || tool === 'create_agent' || tool === 'create_group' ||
      tool === 'update_group' || tool === 'update_agent' || tool === 'delete_agent') {
    return 'squadra'
  }
  return 'altro'
}

/** Le parole di pagamento (la stessa lista dell'insieme fisso di squad-autonomy). */
const PAYMENT_WORDS = [
  'paga', 'pago', 'pagare', 'pagamento', 'acquista', 'acquisto', 'acquistare',
  'compra', 'compro', 'prenota', 'prenoto', 'prenotare', 'ordina', 'ordino',
  'procedi al pagamento', 'paga ora', 'conferma ordine',
  'pay', 'buy', 'purchase', 'checkout', 'place order', 'subscribe'
]
function paymentWordsIn(text: string): boolean {
  const low = text.toLowerCase()
  return PAYMENT_WORDS.some((w) => {
    const body = w.split(/\s+/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u').test(low)
  })
}

/** Perché questa card chiede (pura, dal meta: i marcatori messi dal loop in Q1). */
export function squadApprovalWhy(meta: Record<string, unknown> | null | undefined): SquadApprovalWhy {
  const m = (meta ?? {}) as Record<string, unknown>
  if (m.squadAlwaysAsk === true) return 'fisso'
  if (m.squadReviewerAsk === true) return 'revisore'
  if (m.contaminated === true) return 'contaminato'
  return null
}

/**
 * «Consenti per questa missione» esiste SOLO per sito-interattivo e squadra
 * (8 ore, un grant per membro): mai per dati tuoi, pagamenti, invii, Mac.
 * S3 (fase squadra-sicurezza-2): nemmeno per create_agent/create_group —
 * nascono bot e squadre NUOVI, e quei turni sono protetti da forcedOriginAsk
 * (l'origine del turno decide, non una concessione): la card vale «una volta».
 */
export function missionGrantAllowed(category: SquadApprovalCategory, tool = ''): boolean {
  if (tool === 'create_agent' || tool === 'create_group') return false
  return category === 'sito-interattivo' || category === 'squadra'
}

/** La scadenza del grant di missione: 8 ore da adesso. */
export const MISSION_GRANT_MS = 8 * 60 * 60 * 1000

/**
 * S1 (fase squadra-sicurezza): il target del grant di missione ha SEMPRE un
 * confine preciso, mai vuoto e mai «*». Le azioni del browser valgono per IL
 * SITO (site:host della pagina della card) e SOLO http/https con host pieno:
 * about:blank, data:, file:, un'url illeggibile o mancante tornano NULL (niente
 * grant: la decisione vale «una volta»). La delega vale per IL DESTINATARIO
 * della card (agent:<id>), le altre per la chiave di permesso di sempre.
 */
export function missionGrantTarget(tool: string, input: Record<string, unknown>, browserUrl?: string | null): string | null {
  if (tool.startsWith('browser_')) {
    if (!browserUrl) return null
    try {
      const u = new URL(String(browserUrl))
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.host) return null
      return `site:${u.host}`
    } catch {
      return null
    }
  }
  if (tool === 'send_to_agent') {
    const dest = String(input.agentId ?? '')
    return dest ? `agent:${dest}` : null
  }
  // S3: update_group → group:<gid>, update_agent → agent:<id> (targetKey);
  // la chiave «*» (argomento assente o invalido) NON è un confine → NULL,
  // la decisione vale «una volta»
  const key = targetKey(tool, input)
  return key === '*' ? null : key
}

/**
 * S1 (fase squadra-sicurezza): il target COMPLETO di un grant di missione
 * porta la SQUADRA — squad:<gid>|<target> — perché il grant vale SOLO nei
 * turni di quella squadra (e, per la delega, solo verso il destinatario
 * della card finché ne è membro).
 */
export function missionGrantKey(squadId: number, target: string): string {
  return `squad:${squadId}|${target}`
}

// ---- la raccolta delle card pendenti della squadra ----

export interface SquadPendingApproval {
  agentId: string
  agentName: string
  approvalId: string
  tool: string
  /** la frase leggibile della card di oggi (il content dell'entry) */
  phrase: string
  category: SquadApprovalCategory
  why: SquadApprovalWhy
  when: number
  /** figlio di un membro (il bot mostrato resta il PADRE) */
  fromSubagent: boolean
}

/**
 * Le approvazioni in attesa di tutti i membri e dei loro sottoagenti (pura
 * sulle righe passate; il chiamante raccoglie le entry dallo store). L'ordine
 * è dal più recente.
 */
export function collectPendingApprovals(
  members: ReadonlyArray<{ agentId: string; name: string }>,
  entriesOf: (agentId: string) => TranscriptEntry[],
  childAgentsOf: (memberId: string) => Array<{ id: string; name: string }>
): SquadPendingApproval[] {
  const out: SquadPendingApproval[] = []
  const push = (agentId: string, agentName: string, fromSubagent: boolean): void => {
    for (const e of entriesOf(agentId)) {
      if (e.kind !== 'approval' && e.kind !== 'send-message') continue
      const meta = (e.meta ?? {}) as Record<string, unknown>
      if (meta.status !== 'pending' || typeof meta.approvalId !== 'string') continue
      out.push({
        agentId,
        agentName,
        approvalId: meta.approvalId,
        tool: String(meta.tool ?? ''),
        phrase: e.content,
        category: squadApprovalCategory(e),
        why: squadApprovalWhy(meta),
        when: e.createdAt,
        fromSubagent
      })
    }
  }
  for (const m of members) {
    push(m.agentId, m.name, false)
    for (const c of childAgentsOf(m.agentId)) push(c.id, c.name ?? c.id, true)
  }
  return out.sort((a, b) => b.when - a.when)
}

// ---- i contatori di «Fatto da soli, senza chiederti» (tavola 2) ----

export interface SquadActivityCounter {
  id: 'files' | 'commands' | 'pages' | 'bot-messages'
  count: number
  /** chi li ha fatti (i nomi); «tutti» quando sono più della metà dei membri */
  who: string[]
}

/**
 * I contatori del lavoro fatto senza chiedere nei turni della squadra (pura):
 * conta le entry con meta.squadId === groupId. I file scritti e i comandi dal
 * tool-call riuscito, le pagine lette dai web_fetch, i messaggi tra bot dai
 * post degli agenti nel gruppo (i group_messages con author_kind 'agent').
 */
export function squadActivityCounters(
  entriesByAgent: ReadonlyArray<{ agentId: string; name: string; entries: TranscriptEntry[] }>,
  agentGroupMessages: ReadonlyArray<{ author_kind: string; author_id: string | null; author_name?: string | null }>,
  groupId: number
): SquadActivityCounter[] {
  const files = new Map<string, number>()
  const commands = new Map<string, number>()
  const pages = new Map<string, number>()
  const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1) }
  for (const a of entriesByAgent) {
    for (const e of a.entries) {
      const meta = (e.meta ?? {}) as Record<string, unknown>
      if (meta.squadId !== groupId) continue
      if (e.kind !== 'tool-call') continue
      const name = String(meta.name ?? e.content)
      if (name === 'write-file') bump(files, a.name)
      else if (name === 'run-command') bump(commands, a.name)
      else if (name === 'web_fetch' || name === 'web_search') bump(pages, a.name)
    }
  }
  const msgs = new Map<string, number>()
  // K3, difetto (b): un messaggio fra bot si CONTA per autore (l'id), ma si
  // NOMINA col nome del bot — quello dei membri della squadra (entriesByAgent)
  // o, per un autore che non è più tra loro, il nome salvato nel messaggio
  // (author_name). Prima qui finiva l'id, e «Fatto da soli» diceva «a, b»
  const nomeDi = new Map<string, string>()
  for (const a of entriesByAgent) nomeDi.set(a.agentId, a.name)
  for (const m of agentGroupMessages) {
    if (m.author_kind !== 'agent' || !m.author_id) continue
    if (m.author_name && !nomeDi.has(m.author_id)) nomeDi.set(m.author_id, m.author_name)
    bump(msgs, m.author_id)
  }
  const names = (m: Map<string, number>): string[] => [...m.entries()].filter(([, n]) => n > 0).map(([k]) => nomeDi.get(k) ?? k).sort()
  return [
    { id: 'files', count: [...files.values()].reduce((s, n) => s + n, 0), who: names(files) },
    { id: 'commands', count: [...commands.values()].reduce((s, n) => s + n, 0), who: names(commands) },
    { id: 'pages', count: [...pages.values()].reduce((s, n) => s + n, 0), who: names(pages) },
    { id: 'bot-messages', count: [...msgs.values()].reduce((s, n) => s + n, 0), who: names(msgs) }
  ]
}
