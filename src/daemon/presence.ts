// Presenza e check-in al rientro (fase 6, §3bis L9 + §3ter T2):
// - la UI invia segnali 'active' (focus/keydown/mouse, al massimo uno ogni
//   30 s) e 'typing'; il daemon persiste l'ultimo istante di presenza
// - al ritorno dopo minAwayHours (default 12) il bot principale esegue il
//   look-around: PRIMA una send-message FISSA (non generata dal modello),
//   poi un turno con prompt dedicato; rate limit: uno ogni 12 ore
// - assenza più lunga di awayPauseDays (default 7): le routine attive vanno
//   in pausa (flag pausedForAway, provenance invariata) e al rientro il bot
//   chiede con ask_user se riattivarle — la risposta riprende SOLO quelle.
// Tutto il tempo passa da deps.now(): nei test l'orologio è finto.
import type { Agent, SandbotEvent, SendMessagePayload, WidgetOption } from '../shared/types'
import type { Routine } from '../main/store/db'
// fase 17c (C4): il messaggio fisso del check-in e il widget delle routine in
// pausa sono testi del BOT all'utente — lingua dell'utente; il titolo
// presence_return resta com'è (lo legge il modello nel blocco <evento>)
import { currentUserLanguage } from '../main/agent/user-language'
import { formatUi, ui } from '../shared/ui-text'
import { UI } from '../shared/ui-messages'

/** Massimo un segnale 'active' accettato ogni 30 s (gli altri sono solo rumore). */
export const ACTIVE_SIGNAL_MIN_MS = 30_000

export const DEFAULT_MIN_AWAY_HOURS = 12
export const DEFAULT_AWAY_PAUSE_DAYS = 7
/** Rate limit del look-around: al massimo uno ogni 12 ore. */
export const LOOKAROUND_RATE_MS = 12 * 3_600_000

export const LAST_SEEN_SETTING = 'presence.lastSeen'
export const LOOKAROUND_LAST_SETTING = 'lookaround.lastAt'

/** Soglie configurabili (Impostazioni → generale). */
export interface PresenceSettings {
  minAwayHours: number
  awayPauseDays: number
}

/** Puro: il ritorno è "lungo" rispetto alla soglia? (primo segnale sempre no) */
export function isLongReturn(prevSeen: number, now: number, minAwayHours: number): boolean {
  if (!prevSeen) return false
  return now - prevSeen >= minAwayHours * 3_600_000
}

/** Puro: il look-around è ammesso (rate limit 12h)? */
export function lookaroundAllowed(lastAt: number, now: number): boolean {
  return now - lastAt >= LOOKAROUND_RATE_MS
}

/** Puro: l'utente è "via da giorni" (pausa delle routine)? */
export function isAwayForDays(lastSeen: number, now: number, awayPauseDays: number): boolean {
  return !!lastSeen && now - lastSeen >= awayPauseDays * 86_400_000
}

export interface PresenceDeps {
  now(): number
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  emit(e: SandbotEvent): void
  listAgents(): Agent[]
  listRoutines(): Routine[]
  updateRoutine(id: number, patch: Partial<Pick<Routine, 'enabled' | 'paused_for_away'>>): void
  /** Entry visibile creata dal sistema (non dal modello): apertura fissa e widget ask_user. */
  appendSystemSend(agentId: string, message: SendMessagePayload, meta?: Record<string, unknown>): void
  /** Accoda il turno look-around (job user-message con initiator LOOK_AROUND). */
  enqueueLookaround(agentId: string): void
  /** Accoda il run di una routine con evento (trigger presence_return). */
  enqueueRoutineRun(routine: Routine, event: { source: 'presence_return'; title: string; at: number }): void
  pokeWorker(): void
}

/** Il bot principale: setting mainAgentId, altrimenti il primo agente (il più vecchio). */
export function mainAgentOf(agents: Agent[], mainAgentId: string | null | undefined): Agent | null {
  if (mainAgentId) {
    const found = agents.find((a) => a.id === mainAgentId)
    if (found) return found
  }
  return agents[0] ?? null
}

export function createPresence(deps: PresenceDeps) {
  const settings = (): PresenceSettings => ({
    minAwayHours: deps.getSetting<number>('minAwayHours', DEFAULT_MIN_AWAY_HOURS),
    awayPauseDays: deps.getSetting<number>('awayPauseDays', DEFAULT_AWAY_PAUSE_DAYS)
  })
  let lastActiveAccepted = 0
  /** agente che l'utente sta guardando (finestra a fuoco sulla sua chat). */
  let viewingAgent: string | null = null

  /** Le routine attive che verrebbero messe in pausa per assenza lunga. */
  const pausableRoutines = (): Routine[] => deps.listRoutines().filter((r) => r.enabled)

  return {
    /** Ultimo istante di presenza persistito. */
    lastSeen(): number {
      return deps.getSetting<number>(LAST_SEEN_SETTING, 0)
    },

    /** L'agente che l'utente sta guardando (per la soppressione delle notifiche). */
    viewingAgent(): string | null {
      return viewingAgent
    },

    /** Quando l'utente ha letto l'ultima volta la chat di un agente (0 = mai). */
    readAt(agentId: string): number {
      return deps.getSetting<Record<string, number>>('presence.readAt', {})[agentId] ?? 0
    },

    /**
     * L'utente sta guardando la chat di un agente (o nessuna): segna la
     * chat come letta (le notifiche per quell'agente sono soppresse) e vale
     * come presenza (l'utente è al computer).
     */
    onViewing(agentId: string | null): void {
      viewingAgent = agentId
      if (!agentId) return
      const now = deps.now()
      const readAtMap = deps.getSetting<Record<string, number>>('presence.readAt', {})
      readAtMap[agentId] = now
      deps.setSetting('presence.readAt', readAtMap)
      this.onSignal('active')
    },

    /**
     * Segnale di presenza dalla UI. 'active' è accettato al massimo ogni 30 s;
     * un segnale dopo un'assenza oltre la soglia fa scattare il rientro
     * (look-around del bot principale + routine con trigger presence_return).
     */
    onSignal(kind: 'active' | 'typing'): void {
      const now = deps.now()
      if (kind === 'active') {
        if (now - lastActiveAccepted < ACTIVE_SIGNAL_MIN_MS) return
        lastActiveAccepted = now
      }
      const prev = this.lastSeen()
      deps.setSetting(LAST_SEEN_SETTING, now)
      if (!isLongReturn(prev, now, settings().minAwayHours)) return
      this.handleReturn(now)
    },

    /**
     * Il rientro dopo l'assenza lunga: messaggio fisso + eventuale domanda
     * sulle routine in pausa + turno look-around (rate limit 12h) + le
     * routine con trigger presence_return.
     */
    handleReturn(now: number): void {
      // routine a evento: presence_return scatta a ogni ritorno qualificato
      for (const r of deps.listRoutines()) {
        if (r.enabled && r.trigger?.type === 'presence_return') {
          deps.enqueueRoutineRun(r, { source: 'presence_return', title: 'L\'utente è appena tornato al computer', at: now })
        }
      }
      const main = mainAgentOf(deps.listAgents(), deps.getSetting<string | null>('mainAgentId', null))
      if (!main) return
      const lastAt = deps.getSetting<number>(LOOKAROUND_LAST_SETTING, 0)
      if (!lookaroundAllowed(lastAt, now)) return
      deps.setSetting(LOOKAROUND_LAST_SETTING, now)
      const lang = currentUserLanguage()
      // 1. send-message FISSA (non generata dal modello), nella lingua dell'utente
      deps.appendSystemSend(main.id, { type: 'text', text: formatUi(ui(UI.lookaroundOpening), lang) })
      // 2. se ci sono routine in pausa per assenza: la domanda fissa con
      //    ask_user (la risposta riprende SOLO quelle, in modo deterministico)
      const pausedAway = deps.listRoutines().filter((r) => !r.enabled && r.paused_for_away)
      if (pausedAway.length) {
        const options: WidgetOption[] = [
          { label: formatUi(ui(UI.presenceResumeAll), lang), value: 'resume-away', style: 'primary' },
          { label: formatUi(ui(UI.presenceKeepPaused), lang), value: 'keep-paused' }
        ]
        deps.appendSystemSend(main.id, {
          type: 'widget',
          prompt: formatUi(ui(UI.presenceAwayPrompt), lang),
          options
        }, { awayResume: true })
      }
      // 3. il turno look-around vero e proprio
      deps.enqueueLookaround(main.id)
      deps.pokeWorker()
    },

    /**
     * Tick del daemon: assenza oltre awayPauseDays → le routine attive vanno
     * in pausa con flag pausedForAway (idempotente, provenance invariata).
     */
    maybePauseForAway(): number {
      const now = deps.now()
      const lastSeen = this.lastSeen()
      if (!isAwayForDays(lastSeen, now, settings().awayPauseDays)) return 0
      let paused = 0
      for (const r of pausableRoutines()) {
        deps.updateRoutine(r.id, { enabled: 0, paused_for_away: 1 })
        paused++
      }
      return paused
    },

    /**
     * Risposta alla domanda sulle routine in pausa: "Riattiva tutte" riprende
     * SOLO le routine con pausedForAway (quelle messe in pausa dal sistema,
     * non quelle fermate dall'utente a mano). Torna quante ne ha riprese.
     */
    resumeAwayPaused(): number {
      let resumed = 0
      for (const r of deps.listRoutines()) {
        if (!r.enabled && r.paused_for_away) {
          deps.updateRoutine(r.id, { enabled: 1, paused_for_away: 0 })
          resumed++
        }
      }
      return resumed
    }
  }
}

export type Presence = ReturnType<typeof createPresence>
