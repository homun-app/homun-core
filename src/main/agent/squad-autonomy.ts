// Q1 (fase squadra): l'autonomia della squadra — logica PURA, condivisa dal
// gate dei permessi (loop/permissions), dai turni del daemon e dai test.
// Le tre colonne del disegno (tela E1UivWqEiuZqVjkkR9K5hx, tavola 3) e
// l'insieme FISSO che nessuna autonomia, regola o revisore può togliere:
// a decidere restano il prodotto e l'utente, MAI un bot (coordinatore compreso).
import type { BrowserAskInfo } from './browser-guard'

/** I tre valori di groups.autonomy. */
export type GroupAutonomy = 'ask' | 'box' | 'box_review'

/** I tre valori, nell'ordine del disegno. */
export const GROUP_AUTONOMIES: readonly GroupAutonomy[] = ['ask', 'box', 'box_review']

/**
 * Normalizza il valore della colonna: i DB vecchi (colonna appena aggiunta,
 * NULL) e qualunque valore invalido diventano 'box' — il default della spec
 * per le squadre esistenti E per quelle nuove.
 */
export function normalizeGroupAutonomy(v: unknown): GroupAutonomy {
  return v === 'ask' || v === 'box' || v === 'box_review' ? v : 'box'
}

// ---- le due colonne del disegno (tavola 3) ----

export interface DesignRow {
  id: string
  /** il testo della riga nel disegno */
  label: string
  kind: 'passes-column' | 'always-asks-column'
  /** nei test: il revisore che direbbe sì NON toglie l'insieme fisso */
  reviewerAllows?: boolean
}

/** La colonna «Fa da sola» (con i contorni che la spec chiede di provare). */
export const DESIGN_FA_DA_SOLA: readonly DesignRow[] = [
  { id: 'file-in-computer', label: 'create and edit files in the computer', kind: 'passes-column' },
  { id: 'file-outside-box', label: 'create files outside the computer', kind: 'passes-column' },
  { id: 'commands-no-network', label: 'run commands and code in the computer, with no network', kind: 'passes-column' },
  { id: 'commands-with-network', label: 'run commands in the computer with the network open', kind: 'passes-column' },
  { id: 'web-pages', label: 'read and search web pages', kind: 'passes-column' },
  { id: 'talk-between-bots', label: 'bots of the team talking to each other', kind: 'passes-column' },
  { id: 'talk-between-bots-contaminated', label: 'bots talking with untrusted content in the turn', kind: 'passes-column' },
  { id: 'subagents', label: 'launch subagents', kind: 'passes-column' },
  { id: 'documents', label: 'write documents in the Library', kind: 'passes-column' }
]

/** La colonna «Chiede sempre a te» — l'insieme FISSO del codice. */
export const DESIGN_CHIEDE_SEMPRE: readonly DesignRow[] = [
  { id: 'your-data', label: 'forms with your data, logins, Vault', kind: 'always-asks-column' },
  { id: 'payments', label: 'payments and purchases', kind: 'always-asks-column' },
  { id: 'outbound', label: 'email, messages and posts going out', kind: 'always-asks-column' },
  { id: 'mac', label: 'actions on your Mac outside the computer', kind: 'always-asks-column' },
  { id: 'delete-bot', label: 'delete a bot', kind: 'always-asks-column' },
  { id: 'not-yours', label: 'change a bot you did not create', kind: 'always-asks-column' }
]

/**
 * Il verdetto di una riga del disegno con una data autonomia (pura). La
 * colonna «Chiede sempre a te» non cambia MAI: reviewerAllows non la toglie
 * (il revisore non decide per l'utente sulle azioni dell'insieme fisso).
 */
export function designRowVerdict(row: DesignRow, autonomy: GroupAutonomy): 'passa' | 'chiede' {
  if (row.kind === 'always-asks-column') return 'chiede'
  switch (row.id) {
    // file: nel computer passano con box/box_review; fuori dal box sempre card
    case 'file-in-computer':
      return autonomy === 'ask' ? 'chiede' : 'passa'
    case 'file-outside-box':
      return 'chiede'
    // comandi: la rete del box aperta riporta la card (un comando con la
    // rete può far uscire i file)
    case 'commands-no-network':
      return autonomy === 'ask' ? 'chiede' : 'passa'
    case 'commands-with-network':
      return 'chiede'
    // già liberi oggi: restano liberi con ogni autonomia
    case 'web-pages':
    case 'subagents':
    case 'documents':
      return 'passa'
    // parlarsi: con box/box_review la delega passa ANCHE contaminata (la
    // contaminazione va avanti col turno di chi riceve); con ask chiede
    case 'talk-between-bots':
      return 'passa'
    case 'talk-between-bots-contaminated':
      return autonomy === 'ask' ? 'chiede' : 'passa'
    default:
      return 'chiede'
  }
}

// ---- l'insieme FISSO che chiede sempre, in ogni autonomia ----

/**
 * I tool dell'insieme fisso: credenziali e Cassaforte, lo scambio di file col
 * Mac, le azioni sul Mac (use-app), l'export dalla Libreria, l'eliminazione
 * di un bot. Le modifiche ai bot d'altri e i pagamenti del browser si giudicano
 * per argomenti in squadAlwaysAsks. Gli invii esterni restano bozze che parte
 * solo dal clic dell'utente (strutturale, vedi external-send): nessuna
 * autonomia li trasforma in invii diretti.
 */
export const SQUAD_ALWAYS_ASK_TOOLS: ReadonlySet<string> = new Set([
  'fill_credential',
  'copy_to_box',
  'copy_from_box',
  'use-app',
  'delete_agent',
  'export_from_library',
  'save_contact'
])

/** Le parole (IT/EN) di PAGAMENTO e ACQUISTO: un clic che le contiene è dell'insieme fisso. */
const SQUAD_PAYMENT_WORDS = [
  'paga', 'pago', 'pagare', 'pagamento', 'acquista', 'acquisto', 'acquistare',
  'compra', 'compro', 'prenota', 'prenoto', 'prenotare', 'ordina', 'ordino',
  'procedi al pagamento', 'paga ora', 'conferma ordine',
  'pay', 'buy', 'purchase', 'checkout', 'place order', 'subscribe'
] as const

/** Confronto per parola intera, case-insensitive (come COMMIT_WORDS del browser). */
function matchesWholeWord(text: string, words: readonly string[]): boolean {
  const low = text.toLowerCase()
  return words.some((w) => {
    const body = w.toLowerCase().split(/\s+/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u').test(low)
  })
}

export interface SquadAlwaysAsksOpts {
  /** il bot del turno (per update_agent sui bot d'altri) */
  callerAgentId?: string
  /** createdBy di un bot (iniettato: niente store qui dentro) */
  createdByOf?: (agentId: string) => string | null | undefined
  /** l'ask del browser-guard, quando c'è (pagamenti = insieme fisso) */
  browserAsk?: Pick<BrowserAskInfo, 'kind' | 'name'> | null
}

/**
 * Q1: quest'azione è dell'insieme FISSO che in un turno di squadra chiede
 * SEMPRE all'utente? Nessuna autonomia, regola, grant o revisore la toglie:
 * la card offre solo «Consenti una volta».
 */
export function squadAlwaysAsks(tool: string, input: Record<string, unknown> | undefined, opts: SquadAlwaysAsksOpts = {}): boolean {
  if (SQUAD_ALWAYS_ASK_TOOLS.has(tool)) return true
  // update_agent sul bot DI UN ALTRO: il proprio si modifica come oggi
  if (tool === 'update_agent') {
    const target = String(input?.agentId ?? '')
    const owner = opts.createdByOf ? opts.createdByOf(target) : null
    if (target && owner != null && owner !== (opts.callerAgentId ?? '')) return true
  }
  // pagamenti e acquisti nel browser: il clic di conferma con parole di
  // pagamento è dell'insieme fisso (gli altri clic possono andare al revisore)
  if (opts.browserAsk && opts.browserAsk.kind === 'commit' && matchesWholeWord(opts.browserAsk.name ?? '', SQUAD_PAYMENT_WORDS)) return true
  return false
}

// ---- la squadra di una delega 1-a-1 ----

/**
 * Q1: la squadra (se c'è) di un send_to_agent. Vale la squadra del TURNO del
 * mittente se anche il destinatario ne è membro; altrimenti l'unica squadra
 * che hanno in comune; con più squadre in comune e nessuna nel turno, nessuna
 * (valgono le impostazioni globali — non si sceglie a caso).
 */
export function delegationSquadId(
  senderSquadId: number | null,
  senderSquads: ReadonlyArray<number>,
  receiverSquads: ReadonlyArray<number>
): number | null {
  if (senderSquadId !== null && receiverSquads.includes(senderSquadId)) return senderSquadId
  const common = senderSquads.filter((g) => receiverSquads.includes(g))
  if (common.length === 1) return common[0]!
  return null
}
