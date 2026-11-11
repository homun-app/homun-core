// B2 (fase beta.4): il turno di presentazione, come enqueueBotIntroRun di
// Rakazo. Il bot creato dal dialogo (SOLO da lì) parte con UN turno aperto
// da un prompt nascosto: saluta, chiama subito ask_user e poi si scrive il
// profilo con update_self. Il prompt è il modello di botIntroPrompt di
// Rakazo (packages/api/src/routes/bots.ts); l'accodamento è idempotente e
// NON parte senza un modello utilizzabile. Tutto con dipendenze iniettate.
import { describe, expect, it } from 'vitest'
import { botIntroPrompt, maybeEnqueueBotIntro, BOT_INTRO_INITIATOR } from '../bot-intro'
import { isConversationEntry } from '../../memory/history-store'
import type { Agent, MainModel, TranscriptEntry } from '../../../shared/types'

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'agent_x', name: 'Prova', description: '', providerId: null, model: null,
  status: 'idle', unread: 0, createdAt: 1, ...over
})

const MAIN: MainModel = { providerId: 'ollama', model: 'glm' }

/** Le dipendenze fintamente registranti dell'accodamento. */
function deps(over: Partial<Parameters<typeof maybeEnqueueBotIntro>[1]> = {}) {
  const enqueued: unknown[] = []
  return {
    enqueued,
    deps: {
      getAgent: (id: string) => (id === 'agent_x' ? agent() : undefined),
      getEntries: (): TranscriptEntry[] => [],
      listProviders: () => [{ id: 'ollama', enabled: true }],
      getSetting: <T,>(key: string, fallback: T): T => (key === 'models.main' ? (MAIN as T) : fallback),
      enqueue: (job: unknown) => { enqueued.push(job); return {} },
      now: () => 1_000,
      ...over
    }
  }
}

describe('B2: botIntroPrompt — il prompt nascosto della presentazione', () => {
  const p = botIntroPrompt(agent({ name: 'Prova' }))

  it('chiama SUBITO ask_user, senza testo prima, e saluta per nome', () => {
    expect(p).toMatch(/Call ask_user right away/i)
    expect(p).toMatch(/no text before it/i)
    expect(p).toMatch(/greet/i)
  })

  it('le opzioni sono 2–4, ADATTE al nome e a ciò che sa, mai un elenco fisso; risposta libera sempre', () => {
    expect(p).toMatch(/two to four short options/i)
    expect(p).toMatch(/fit your name/i)
    expect(p).toMatch(/never a stock list/i)
    expect(p).toMatch(/type their own answer/i)
  })

  it('se il profilo dice già a cosa serve, lo dice in UNA riga invece di chiedere', () => {
    expect(p).toMatch(/already makes that clear/i)
    expect(p).toMatch(/one line/i)
  })

  it('dopo la risposta: update_self per descrizione/istruzioni (e il nome), poi si parte', () => {
    expect(p).toContain('update_self')
    expect(p).toMatch(/one-line description/i)
    expect(p).toMatch(/instructions/i)
    expect(p).toMatch(/one follow-up only/i)
  })

  it('se servono più ruoli può proporre una squadra (nelle opzioni o dopo la risposta)', () => {
    expect(p).toMatch(/team/i)
  })
})

describe('B2: maybeEnqueueBotIntro — UNA presentazione, solo col modello', () => {
  it('con models.main accoda UN job user-message con initiator BOT_INTRO e il prompt', () => {
    const { enqueued, deps: d } = deps()
    expect(maybeEnqueueBotIntro('agent_x', d)).toBe(true)
    expect(enqueued).toHaveLength(1)
    const job = enqueued[0] as { agentId: string; kind: string; payload: { text: string; initiator: string } }
    expect(job.agentId).toBe('agent_x')
    expect(job.kind).toBe('user-message')
    expect(job.payload.initiator).toBe(BOT_INTRO_INITIATOR)
    expect(job.payload.text).toContain('You were just created')
    expect(job.payload.text).toContain('Prova')
  })

  it('SENI modello utilizzabile NON parte: la chat vuota resta com\'è oggi', () => {
    // né models.main, né un modello proprio
    const noMain = deps({ getSetting: <T,>(key: string, fallback: T): T => fallback })
    expect(maybeEnqueueBotIntro('agent_x', noMain.deps)).toBe(false)
    expect(noMain.enqueued).toHaveLength(0)
    // models.main c\'è ma il provider è spento → segue-main irrisolvibile
    const deadProvider = deps({ listProviders: () => [{ id: 'ollama', enabled: false }] })
    expect(maybeEnqueueBotIntro('agent_x', deadProvider.deps)).toBe(false)
  })

  it('un bot con modello PROPRIo attivo parte (segue il modello suo, non il main)', () => {
    const own = deps({
      getAgent: (id: string) => (id === 'agent_x' ? agent({ providerId: 'ollama', model: 'glm' }) : undefined),
      getSetting: <T,>(key: string, fallback: T): T => fallback
    })
    expect(maybeEnqueueBotIntro('agent_x', own.deps)).toBe(true)
    expect(own.enqueued).toHaveLength(1)
  })

  it('IDEMPOTENTE: con un\'apertura BOT_INTRO già nel transcript non accoda nulla', () => {
    const again = deps({
      getEntries: () => [{ id: 1, agentId: 'agent_x', kind: 'message', role: 'user', content: 'prompt', meta: { initiator: 'BOT_INTRO' }, createdAt: 1 } as unknown as TranscriptEntry]
    })
    expect(maybeEnqueueBotIntro('agent_x', again.deps)).toBe(false)
    expect(again.enqueued).toHaveLength(0)
  })

  it('il prompt nascosto NON finisce nella cronologia cercabile (initiator ≠ conversazione)', () => {
    expect(isConversationEntry({ kind: 'message', role: 'user', meta: { initiator: 'BOT_INTRO' } })).toBeNull()
  })
})
