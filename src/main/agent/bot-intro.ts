// B2 (fase beta.4): il turno di presentazione del bot nuovo — come
// enqueueBotIntroRun/botIntroPrompt di Rakazo (apps/api/src/routes/bots.ts).
// Il bot creato dal dialogo «Nuovo» (SOLO da lì: mai da create_agent, mai dai
// modelli) parte con UN turno aperto da un prompt nascosto: saluta l'utente e
// chiama subito ask_user per chiedere a cosa gli serve, poi si scrive il
// profilo con update_self. Il turno «created» può usare solo la domanda e il
// proprio profilo (il loop filtra i tool su BOT_INTRO_INITIATOR, vedi
// connectors-policy), il prompt NON compare in chat (openingRowFor: hidden)
// e non finisce nella cronologia cercabile (initiator ≠ conversazione).
// Tutto a dipendenze iniettate: nei test niente DB, niente LLM, niente rete.
import type { Agent, MainModel, TranscriptEntry } from '../../shared/types'
import { resolveAgentModel } from '../../shared/agent-model'

/** L'initiator del turno di presentazione (in meta.initiator dell'apertura). */
export const BOT_INTRO_INITIATOR = 'BOT_INTRO'

/**
 * Il prompt nascosto della presentazione (PURO), sul modello di botIntroPrompt
 * di Rakazo: la domanda È il saluto (la card sta in piedi da sola), le opzioni
 * sono adatte al nome e a ciò che il bot già sa — mai un elenco fisso — e la
 * risposta libera c'è sempre. Se il profilo dice già a cosa serve, lo dice in
 * una riga invece di chiedere. Poi update_self e si parte.
 */
export function botIntroPrompt(agent: Pick<Agent, 'name'>): string {
  return [
    `You were just created. The user named you "${agent.name}".`,
    'Call ask_user right away, with no text before it. Its question greets them by first name in a few words (if you know it from your memory) and asks what they want you for, with two to four short options that fit your name, anything your profile already says and what you know about them — never a stock list. They can also type their own answer. If what they want seems to need multiple roles, one option (or a follow-up after their answer) may be a team.',
    'If your profile already makes that clear, say in one line what you will do instead of asking.',
    'Once you know what you are for, use update_self to set what is already clear: a one-line description of what you do and your instructions on how you do it. Leave anything vague unset to fill in later, and keep your name and look unless they ask for a different name.',
    'Then get started, asking one follow-up only if you cannot start without it.'
  ].join('\n')
}

/** Le dipendenze dell'accodamento (tutte iniettabili). */
export interface BotIntroDeps {
  getAgent(id: string): Agent | undefined
  getEntries(agentId: string): TranscriptEntry[]
  listProviders(): Array<{ id: string; enabled: boolean }>
  getSetting<T>(key: string, fallback: T): T
  enqueue(job: {
    agentId: string
    kind: 'user-message'
    payload: { text: string; initiator: string }
    runAt: number
    now: number
  }): unknown
  now(): number
}

/**
 * Accoda la presentazione del bot (dal dialogo): UNA volta sola, e SOLO se
 * c'è un modello utilizzabile (Rakazo: needsModel → return) — altrimenti la
 * chat vuota resta com'è oggi. Il job è quello della coda durevole: un
 * riavvio a metà lo riprende come gli altri turni, e l'apertura BOT_INTRO già
 * nel transcript (idempotenza) blocca ogni seconda presentazione.
 */
export function maybeEnqueueBotIntro(agentId: string, deps: BotIntroDeps): boolean {
  const agent = deps.getAgent(agentId)
  if (!agent) return false
  const alreadyIntroduced = deps.getEntries(agentId).some(
    (e) => (e.meta as { initiator?: unknown } | null)?.initiator === BOT_INTRO_INITIATOR
  )
  if (alreadyIntroduced) return false
  const main = deps.getSetting<MainModel | null>('models.main', null)
  const providers = deps.listProviders().map((p) => ({ id: p.id, enabled: p.enabled }))
  const resolved = resolveAgentModel(agent, main, providers)
  if (!resolved) return false
  // «Come gli altri» conta solo se il provider del modello principale è
  // ancora ATTIVO: un provider spento non è un modello utilizzabile
  if (resolved.followsMain && !providers.some((p) => p.id === resolved.providerId && p.enabled)) return false
  const at = deps.now()
  deps.enqueue({
    agentId,
    kind: 'user-message',
    payload: { text: botIntroPrompt(agent), initiator: BOT_INTRO_INITIATOR },
    runAt: at,
    now: at
  })
  return true
}
