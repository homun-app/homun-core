// Fase pagine (G4): i suggerimenti proattivi del pannello Attività come
// FUNZIONE PURA — regole sullo stato già disponibile, MAI dal modello e MAI
// da testo di terzi (solo i messaggi DIRETTI dell'utente a questo bot).
// Regole: 1) app del catalogo nominata e non collegata; 2) 3+ messaggi molto
// simili in giorni diversi negli ultimi 14 giorni; 3) bot senza istruzioni
// con più di 5 turni. Al massimo 3 suggerimenti, ognuno ignorabile per id.
// Le icone sono CHIAVI ('link' | 'repeat' | 'edit'): i componenti lucide
// stanno alla UI, qui niente React.

/** Un messaggio della chat come serve alle regole (i non-utenti si riconoscono dai campi extra). */
export interface SuggestionMessage {
  text: string
  /** ms dall'epoch */
  at: number
  /** presente → NON è un messaggio diretto dell'utente (routine, [sistema]…) */
  initiator?: string
  /** presente → messaggio di un ALTRO bot */
  fromAgentId?: string
}

/** Un'app del catalogo come serve alla regola 1. */
export interface SuggestionApp {
  id: string
  name: string
  /** l'app è collegata per QUESTO bot? */
  connectedForBot: boolean
}

export type SuggestionAction =
  | { kind: 'connect-app'; appId: string }
  | { kind: 'create-routine'; prefill: string }
  | { kind: 'describe-bot' }

export interface BotSuggestion {
  /** stabile per regola+bersaglio: è quello che si ignora con la ✕ */
  id: string
  /** chiave dell'icona (la UI la mappa su lucide) */
  icon: 'link' | 'repeat' | 'edit'
  label: string
  action: SuggestionAction
}

export interface BotSuggestionsInput {
  /** i messaggi della chat di questo bot, in ordine */
  messages: SuggestionMessage[]
  /** le app del catalogo curato */
  apps: SuggestionApp[]
  /** la descrizione del bot (vuota = senza istruzioni) */
  agentDescription: string
  /** quanti turni ha avuto questo bot */
  turns: number
  /** gli id ignorati con la ✕ (setting suggestions.dismissed) */
  dismissed: string[]
}

/** Quanti messaggi utente guarda la regola 1. */
const APP_WINDOW = 20
/** Finestra della regola 2 (giorni) e soglia di similarità. */
const ROUTINE_WINDOW_DAYS = 14
const ROUTINE_SIMILARITY = 0.8
/** La regola 3 scatta oltre questo numero di turni. */
const DESCRIBE_MIN_TURNS = 5

/** La richiesta normalizzata: minuscolo, senza accenti/punteggiatura, spazi collassati. */
export function normalizeRequest(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** I bigrammi di una stringa normalizzata (per il coefficiente di Dice). */
function bigrams(s: string): Map<string, number> {
  const t = ` ${s} `
  const m = new Map<string, number>()
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

/**
 * La similarità fra due testi (0…1), semplice e deterministica, senza
 * modello: il MASSIMO fra il coefficiente di Dice sui bigrammi di caratteri,
 * la frazione di PAROLE INIZIALI condivise (la variante sulla coda: «…di
 * oggi» / «…di stamattina») e 1 per la richiesta PRECISATA (le parole
 * dell'una sono l'inizio dell'altra, da due parole in su). Simmetrica.
 */
export function similarity(a: string, b: string): number {
  const x = normalizeRequest(a)
  const y = normalizeRequest(b)
  if (!x && !y) return 1
  if (!x || !y) return 0
  if (x === y) return 1
  // Dice sui bigrammi
  const bx = bigrams(x)
  const by = bigrams(y)
  let overlap = 0
  let total = 0
  for (const n of bx.values()) total += n
  for (const n of by.values()) total += n
  for (const [g, n] of bx) overlap += Math.min(n, by.get(g) ?? 0)
  const dice = total === 0 ? 0 : (2 * overlap) / total
  // parole iniziali condivise / parole del più lungo (la variante sulla coda)
  const wx = x.split(' ')
  const wy = y.split(' ')
  let shared = 0
  while (shared < wx.length && shared < wy.length && wx[shared] === wy[shared]) shared++
  const prefix = shared / Math.max(wx.length, wy.length)
  // una richiesta PRECISATA: le parole dell'una sono il prefix dell'altra
  // (vale solo da due parole in su: «ciao» da solo non è una richiesta)
  const shorter = Math.min(wx.length, wy.length)
  const refined = shared === shorter && shorter >= 2 && wx.length !== wy.length ? 1 : 0
  return Math.max(dice, prefix, refined)
}

/** Solo i messaggi DIRETTI dell'utente: niente initiator, niente altri bot. */
const directUserMessages = (messages: SuggestionMessage[]): SuggestionMessage[] =>
  messages.filter((m) => !m.initiator && m.fromAgentId === undefined)

/** Il giorno locale (yyyy-mm-dd) di un timestamp. */
function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/**
 * La regola 1: il nome di un'app del catalogo (a parola intera, maiuscole
 * non contano) negli ultimi 20 messaggi diretti dell'utente, e l'app NON è
 * collegata per questo bot. Vince la menzione più recente.
 */
function appSuggestion(input: BotSuggestionsInput): BotSuggestion | null {
  const direct = directUserMessages(input.messages).slice(-APP_WINDOW)
  // le app cercabili col nome, in ordine di lunghezza (i nomi lunghi prima:
  // «Google Drive» non deve perdere contro «Drive»)
  const candidates = input.apps
    .filter((a) => !a.connectedForBot)
    .map((a) => ({ app: a, re: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(a.name)}($|[^\\p{L}\\p{N}])`, 'iu') }))
    .sort((x, y) => y.app.name.length - x.app.name.length)
  for (let i = direct.length - 1; i >= 0; i--) {
    const text = direct[i]!.text
    for (const c of candidates) {
      if (c.re.test(text)) {
        return { id: `connect-app:${c.app.id}`, icon: 'link', label: `Collega ${c.app.name}`, action: { kind: 'connect-app', appId: c.app.id } }
      }
    }
  }
  return null
}

/** L'escape dei caratteri regex nel nome dell'app (i punti di «e.g.»). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * La regola 2: 3 o più messaggi diretti molto simili (stessa richiesta
 * normalizzata, o similarità ≥ 0,8) in giorni DIVERSI negli ultimi 14 giorni.
 * La richiesta proposta è la più recente del gruppo.
 */
function routineSuggestion(input: BotSuggestionsInput, now: number): BotSuggestion | null {
  const since = now - ROUTINE_WINDOW_DAYS * 86_400_000
  const direct = directUserMessages(input.messages).filter((m) => m.at >= since)
  // gruppo a partire dal più recente: ogni messaggio entra nel primo gruppo
  // simile a un suo membro (greedy, deterministico per ordine di input)
  const groups: SuggestionMessage[][] = []
  for (let i = direct.length - 1; i >= 0; i--) {
    const m = direct[i]!
    const nm = normalizeRequest(m.text)
    let placed = false
    for (const g of groups) {
      const similar = g.some((x) => nm === normalizeRequest(x.text) || similarity(m.text, x.text) >= ROUTINE_SIMILARITY)
      if (similar) {
        g.push(m)
        placed = true
        break
      }
    }
    if (!placed) groups.push([m])
  }
  for (const g of groups) {
    const days = new Set(g.map((m) => dayKey(m.at)))
    if (g.length >= 3 && days.size >= 3) {
      // la più recente: i gruppi sono stati costruiti dal fondo
      const request = g[0]!.text.trim()
      return {
        id: 'create-routine',
        icon: 'repeat',
        label: 'Crea una routine',
        action: { kind: 'create-routine', prefill: `Fai di questo una routine: ${request}` }
      }
    }
  }
  return null
}

/**
 * G4: al massimo 3 suggerimenti per questo bot, in ordine (app, routine,
 * descrizione), senza quelli ignorati. Pura e deterministica.
 */
export function botSuggestions(input: BotSuggestionsInput, now: number = Date.now()): BotSuggestion[] {
  const dismissed = new Set(input.dismissed)
  const all = [
    appSuggestion(input),
    routineSuggestion(input, now),
    !input.agentDescription.trim() && input.turns > DESCRIBE_MIN_TURNS
      ? ({ id: 'describe-bot', icon: 'edit', label: 'Descrivi cosa fa questo bot', action: { kind: 'describe-bot' } } as BotSuggestion)
      : null
  ].filter((s): s is BotSuggestion => s !== null)
  return all.filter((s) => !dismissed.has(s.id)).slice(0, 3)
}
