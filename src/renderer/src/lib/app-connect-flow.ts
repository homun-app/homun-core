// B3 (fase b20-bug): il flusso «Connetti» in un passo della riga
// dell'elenco app — PURO, senza React: l'hook useConnectFlows (AppsWindow) lo
// crea una volta e ne legge le righe. Prima il clic aspettava apps:connect
// senza dire niente, un errore spariva in un catch e la riga restava «Completa
// il login…» per sempre quando Composio non dava il link. Ora:
// - dal clic la riga è «in avvio» (un secondo clic non raddoppia la richiesta);
// - la risposta dice se il collegamento è partito (il login è aperto nel
//   browser di sistema) oppure PERCHÉ no: la riga mostra il motivo con «Riprova»;
// - nessuna risposta entro APP_CONNECT_MAX_MS → la riga si sblocca con un
//   avviso e «Riprova» (orologio e timer iniettabili: i test li fingono);
// - i flussi che continuano in background (login di Composio, connettore
//   diretto) portano sulla riga l'esito che il daemon pubblica
//   (composio-gateway:status.appConnect) — solo quello della PROVA in corso.
import { msg } from '@lingui/core/macro'
import { APP_CONNECT_MAX_MS, type AppConnectFailReason, type AppConnectFailureInfo, type AppConnectPhase } from '../../../shared/app-connect'
import type { AppsConnectResult } from '../../../shared/types'
import { i18n } from './i18n'

/** Lo stato visibile di una riga durante «Connetti» (null = ferma: Connetti/Connessa/Ricollega). */
export type AppFlowKind = 'starting' | 'direct' | 'login' | 'app' | 'failed' | 'conflict'

export interface AppFlowFailure {
  reason: AppConnectFailReason
  /** il motivo in parole, nella lingua dell'interfaccia */
  text: string
  /** il dettaglio tecnico, ripulito e tagliato, quando c'è */
  detail?: string
}

export interface AppFlowView {
  kind: AppFlowKind | null
  failure: AppFlowFailure | null
}

/** La prova di «Connetti» di una riga (una per riga: quella nuova sostituisce la vecchia). */
export interface AppConnectAttempt {
  token: number
  phase: 'starting' | AppConnectPhase | 'conflict'
  /** quando è partita (orologio del renderer): l'esito pubblicato vale solo se è nato dopo */
  startedAt: number
  failure: AppFlowFailure | null
}

/** Ciò che i connettori e il gateway dicono sul momento (letto a ogni render). */
export interface AppFlowEnv {
  connected: 'connected' | 'reconnect' | null
  composioSlug?: string
  gatewayConnected: boolean
  pending: { slug: string; failed?: boolean } | null | undefined
  /** l'esito che il daemon pubblica per i flussi in background (assente con un vecchio daemon) */
  published?: AppConnectFailureInfo | null
}

export interface AppConnectFlowsDeps {
  appsConnect(appId: string): Promise<AppsConnectResult>
  appsCancelConnect(appId: string): Promise<unknown>
  /** lo stato di una riga è cambiato: chi ascolta ridisegna */
  changed(): void
  /** dopo una risposta (o il tempo massimo) si rileggono connettori e gateway */
  refreshed(): void
  now?(): number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(id: unknown): void
  /** il tempo massimo dell'attesa della risposta (i test lo accorciano; default APP_CONNECT_MAX_MS) */
  maxMs?: number
}

const IDLE: AppFlowView = { kind: null, failure: null }
const STARTING: AppFlowView = { kind: 'starting', failure: null }
const DIRECT: AppFlowView = { kind: 'direct', failure: null }
const LOGIN: AppFlowView = { kind: 'login', failure: null }
const APP: AppFlowView = { kind: 'app', failure: null }
const CONFLICT: AppFlowView = { kind: 'conflict', failure: null }

/**
 * L'esito pubblicato che riguarda UNA prova: stessa riga, e nato col clic o
 * dopo (uno di prima è di una prova vecchia: non conta).
 */
export function appConnectPublishedFailure(
  appId: string,
  since: number,
  published: AppConnectFailureInfo | null | undefined
): AppConnectFailureInfo | null {
  return published && published.appId === appId && published.at >= since ? published : null
}

/**
 * L'esito che vale per una riga SENZA prove in corso, prima del clic: solo
 * «Composio non può collegare questa app» — un fatto che non passa da solo,
 * lo si dice senza far rifare il clic. Gli esiti passeggeri (nessuna
 * risposta, errore di rete) non si ricordano: domani non valgono più.
 */
export function rememberedNotConnectable(
  appId: string,
  published: AppConnectFailureInfo | null | undefined
): AppConnectFailureInfo | null {
  return published && published.appId === appId && published.reason === 'not-connectable' ? published : null
}

/**
 * PURA: lo stato visibile di una riga dalla sua prova e da ciò che dicono i
 * connettori. `starting` finché arriva la risposta; `failed` con il motivo
 * quando la prova ha un esito negativo (suo, o pubblicato dal daemon per i
 * flussi in background); `login`/`app` durante l'attesa nel browser; la riga
 * collegata chiude tutto. Senza una prova in corso la riga è ferma — a meno
 * che Composio non possa collegare quell'app: allora lo dice prima del clic.
 */
export function appFlowView(appId: string, a: AppConnectAttempt | null, env: AppFlowEnv): AppFlowView {
  if (!a) {
    const remembered = env.connected === 'connected' ? null : rememberedNotConnectable(appId, env.published)
    return remembered ? { kind: 'failed', failure: { reason: 'not-connectable', text: remembered.error } } : IDLE
  }
  if (a.failure) return { kind: 'failed', failure: a.failure }
  if (a.phase === 'conflict') return CONFLICT
  // solo il collegamento FATTO chiude il flusso: uno stato «da ricollegare»
  // arrivato a metà flusso non deve spezzare l'attesa visibile all'utente
  if (env.connected === 'connected') return IDLE
  if (a.phase === 'direct') return DIRECT
  // in attesa della risposta al clic: il tempo massimo lo fa scattare il flusso (il suo timer)
  if (a.phase === 'starting') return STARTING
  const mine = appConnectPublishedFailure(appId, a.startedAt, env.published)
  if (mine) {
    return { kind: 'failed', failure: { reason: mine.reason, text: mine.error, ...(mine.detail ? { detail: mine.detail } : {}) } }
  }
  if (a.phase === 'login' && !env.gatewayConnected) return LOGIN
  // l'attesa del login dell'app è finita male (WAIT scaduta, login non completato)
  if (env.composioSlug && env.pending?.slug === env.composioSlug && env.pending.failed) {
    return {
      kind: 'failed',
      failure: { reason: 'connect-failed', text: i18n._(msg`Il login nel browser non è stato completato: riprova e completalo entro 5 minuti.`) }
    }
  }
  return APP
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e ?? '')).trim()

/** La prova di una riga è finita male: il motivo dal risultato di apps:connect (o da un'eccezione). */
const failureOf = (r: AppsConnectResult | undefined, error: unknown): AppFlowFailure => {
  const text = error !== undefined ? errorText(error) : (r?.error ?? '').trim()
  const reason: AppConnectFailReason = r?.reason === 'not-connectable' || r?.reason === 'timeout' ? r.reason : 'connect-failed'
  const detail = r?.detail?.trim()
  return {
    reason,
    // mai una riga muta: senza un motivo dal daemon, una frase sua
    text: text || i18n._(msg`Collegamento non riuscito: riprova.`),
    ...(detail ? { detail } : {})
  }
}

/**
 * Il flusso dei «Connetti» delle righe: stato per riga, orologio e timer
 * iniettabili. `connect` non rifiuta mai; ogni promessa del flusso ha il suo
 * esito (anche la risposta tardiva di una prova già chiusa).
 */
export function createAppConnectFlows(deps: AppConnectFlowsDeps) {
  const now = (): number => deps.now?.() ?? Date.now()
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
  const maxMs = deps.maxMs ?? APP_CONNECT_MAX_MS
  const seconds = Math.round(maxMs / 1000)
  let seq = 0
  const attempts = new Map<string, AppConnectAttempt>()
  const timers = new Map<string, unknown>()

  /** Spegne il timer dell'avvio di una riga (se c'è ancora). */
  const dropTimer = (appId: string, onlyIf?: unknown): void => {
    if (onlyIf !== undefined && timers.get(appId) !== onlyIf) return
    const timer = timers.get(appId)
    if (timer !== undefined) clearTimer(timer)
    timers.delete(appId)
  }
  const put = (appId: string, a: AppConnectAttempt | null): void => {
    if (a) attempts.set(appId, a)
    else attempts.delete(appId)
    deps.changed()
  }
  /** Il clic ha sostituito l'intenzione di un'altra riga (login già in corso): quella torna a «Connetti». */
  const release = (appId: string): void => {
    const other = attempts.get(appId)
    if (!other || other.phase !== 'login') return
    dropTimer(appId)
    attempts.delete(appId)
    deps.changed()
  }
  /** La risposta di apps:connect (o la sua eccezione) per la prova `token`. */
  const settle = (appId: string, token: number, startedAt: number, r?: AppsConnectResult, error?: unknown): void => {
    if (r?.replaces) release(r.replaces)
    const a = attempts.get(appId)
    // annullata o sostituita nel frattempo: non parla più
    if (!a || a.token !== token) return
    dropTimer(appId)
    const next: AppConnectAttempt =
      r && r.started
        ? { token, phase: r.phase ?? 'direct', startedAt, failure: null }
        : r?.conflict
          ? { token, phase: 'conflict', startedAt, failure: null }
          : { token, phase: 'app', startedAt, failure: failureOf(r, error) }
    attempts.set(appId, next)
    deps.changed()
    deps.refreshed()
  }

  return {
    /**
     * Il clic su «Connetti». Si scioglie al PRIMO esito della prova — la
     * risposta di apps:connect o il tempo massimo — e non rifiunge mai; se la
     * riga viene annullata mentre aspetta resta appeso (chi chiama non lo
     * aspetta: è `void`), senza lasciare niente acceso.
     */
    async connect(row: { app: { id: string } }): Promise<void> {
      const appId = row.app.id
      // già in avvio: il secondo clic non raddoppia la richiesta
      if (attempts.get(appId)?.phase === 'starting') return
      const token = ++seq
      const startedAt = now()
      dropTimer(appId)
      attempts.set(appId, { token, phase: 'starting', startedAt, failure: null })
      deps.changed()
      // il tempo massimo: nessuna risposta → la riga si sblocca con l'avviso
      let expire: (() => void) | null = null
      const expired = new Promise<void>((resolve) => { expire = resolve })
      const timer = setTimer(() => {
        timers.delete(appId)
        expire?.()
        expire = null
        const a = attempts.get(appId)
        // nel frattempo annullata o rifatta: non parla più
        if (!a || a.token !== token || a.phase !== 'starting') return
        attempts.set(appId, {
          ...a,
          failure: { reason: 'timeout', text: i18n._(msg`Nessuna risposta entro ${seconds} secondi: riprova.`) }
        })
        deps.changed()
      }, maxMs)
      timers.set(appId, timer)
      // la richiesta parte SUBITO (un'eccezione sincrona è un esito come gli altri)
      let answered: Promise<void>
      try {
        answered = Promise.resolve(deps.appsConnect(appId)).then(
          (r) => settle(appId, token, startedAt, r),
          (e: unknown) => settle(appId, token, startedAt, undefined, e)
        )
      } catch (e) {
        answered = Promise.resolve(settle(appId, token, startedAt, undefined, e))
      }
      await Promise.race([answered, expired])
    },
    async cancel(row: { app: { id: string } }): Promise<void> {
      const appId = row.app.id
      dropTimer(appId)
      put(appId, null)
      try {
        await deps.appsCancelConnect(appId)
      } catch { /* il daemon può essere già fermo: la riga è libera lo stesso */ }
      deps.refreshed()
    },
    viewOf: (appId: string, env: AppFlowEnv): AppFlowView => appFlowView(appId, attempts.get(appId) ?? null, env),
    /** c'è una prova in corso (o in attesa nel browser): la riga rilegge lo stato */
    hasPending: (): boolean => [...attempts.values()].some((a) => !a.failure && a.phase !== 'conflict'),
    /** Le righe COLLEGATE chiudono la loro prova (e con lei il polling): quante ne ha chiuse. */
    dropClosed: (...appIds: string[]): number => {
      let dropped = 0
      for (const appId of appIds) {
        if (!attempts.has(appId)) continue
        dropTimer(appId)
        attempts.delete(appId)
        dropped++
      }
      return dropped
    },
    /** allo smontaggio: nessun timer resta acceso */
    dispose: (): void => {
      for (const timer of timers.values()) clearTimer(timer)
      timers.clear()
    }
  }
}

export type AppConnectFlows = ReturnType<typeof createAppConnectFlows>
