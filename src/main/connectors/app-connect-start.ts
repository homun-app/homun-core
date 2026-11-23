// B3 (fase b20-bug): l'AVVIO di un collegamento Composio («Connetti» in un
// passo, apps:connect → connectApp) ha un ESITO che si può leggere. Prima la
// promessa di connectApp partiva orfana: quando Composio non dava il link
// (un'app senza configurazione di accesso) o non rispondeva, la riga restava
// «Completa il login…» per sempre. Qui i pezzi PURI:
// - connectStartOutcomeOf: l'esito di connectApp diventa un motivo in parole
//   (id del catalogo UI + valori: lo forma il daemon nella lingua dell'interfaccia);
// - awaitAppStart: l'attesa dell'esito non resta mai appesa (tempo massimo;
//   la risposta tardiva, anche un rifiuto, resta catturata);
// - connectDetailOf: il dettaglio tecnico si ripulisce (mai link, mai segreti);
// - appStartTimeoutMs: il tempo massimo del daemon, accorciabile dalla sonda.
import { UI } from '../../shared/ui-messages'
import { APP_CONNECT_DAEMON_TIMEOUT_MS, APP_CONNECT_MAX_MS, type AppConnectFailReason } from '../../shared/app-connect'
import type { UiMessageDescriptor } from '../../shared/ui-text'
import { redactComposioSecrets } from './composio-actions'
import { clipErrorText } from '../mcp/error-category'
import type { ComposioGatewayManager } from './composio-gateway'

export type ConnectAppResult = Awaited<ReturnType<ComposioGatewayManager['connectApp']>>

/** L'esito dell'AVVIO: partito (il login è aperto nel browser), oppure perché no. */
export type AppStartOutcome =
  | { ok: true }
  | {
      ok: false
      reason: AppConnectFailReason
      /** il messaggio del catalogo UI (lo forma il daemon con `values`) */
      message: UiMessageDescriptor
      values?: Record<string, string | number>
      /** il dettaglio tecnico, ripulito: solo quando il motivo non è già chiaro */
      detail?: string
    }

/**
 * Le parole con cui Composio dice che il login di un toolkit non lo gestisce
 * (serve la configurazione dello sviluppatore): le stesse che riconosce la
 * strada della chiave (isNoManagedAuthError in composio.ts), più la richiesta
 * di un'app custom. Si guarda SOLO quando l'add non ha dato nessun link.
 */
const NO_MANAGED_AUTH =
  /no[\s_-]*managed[\s_-]*auth|auth[\s_-]*config[\s\S]{0,60}(?:not[\s_-]*found|missing|required|not[\s_-]*configured)|use_custom_app|developer must configure/i

export function noManagedAuthIn(output: string): boolean {
  return NO_MANAGED_AUTH.test(output)
}

/**
 * Il dettaglio tecnico di un esito negativo, per la riga: mai link (possono
 * portare token di sessione), mai segreti, tagliato come gli errori dei
 * server. Il vuoto non c'è (undefined).
 */
export function connectDetailOf(error: string | undefined): string | undefined {
  const text = redactComposioSecrets((error ?? '').replace(/https?:\/\/\S+/gi, '')).trim()
  return text ? clipErrorText(text) : undefined
}

/** L'esito di connectApp → il motivo. `error` grezzo resta com'era per gli altri chiamanti. */
export function connectStartOutcomeOf(r: ConnectAppResult, name: string): AppStartOutcome {
  if (r.ok) return { ok: true }
  if (r.reason === 'not-connectable') return { ok: false, reason: 'not-connectable', message: UI.appConnectNotConnectable, values: { name } }
  if (r.reason === 'timeout') return { ok: false, reason: 'timeout', message: UI.appConnectTimeout, values: { name } }
  if (r.reason === 'browser') return { ok: false, reason: 'connect-failed', message: UI.appConnectBrowser, values: { name } }
  if (r.error === 'account-limit') {
    return { ok: false, reason: 'connect-failed', message: UI.appConnectAccountLimit, values: { count: r.accountCount ?? 5, name } }
  }
  if (r.error === 'not-active') return { ok: false, reason: 'connect-failed', message: UI.appConnectNotActive, values: { name } }
  const detail = connectDetailOf(r.error)
  return { ok: false, reason: 'connect-failed', message: UI.appConnectFailed, values: { name }, ...(detail ? { detail } : {}) }
}

/** connectApp (o l'attesa) è CADUTA con un'eccezione: motivo generico + il dettaglio ripulito. */
export function connectThrewOutcome(e: unknown, name: string): AppStartOutcome {
  const detail = connectDetailOf(e instanceof Error ? e.message : String(e ?? ''))
  return { ok: false, reason: 'connect-failed', message: UI.appConnectFailed, values: { name }, ...(detail ? { detail } : {}) }
}

/**
 * Aspetta l'esito dell'avvio per AL PIÙ `timeoutMs`: poi risponde «timeout».
 * La promessa di partenza non resta mai orfana — la sua risposta tardiva
 * (anche un rifiuto) è sempre catturata qui, e il timer si spegne con l'esito.
 */
export async function awaitAppStart(
  start: Promise<ConnectAppResult>,
  timeoutMs: number,
  name = '',
  timers: { set?: (fn: () => void, ms: number) => unknown; clear?: (id: unknown) => void } = {}
): Promise<AppStartOutcome> {
  const set = timers.set ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clear = timers.clear ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
  let timer: unknown
  const expired = new Promise<AppStartOutcome>((resolve) => {
    timer = set(() => resolve({ ok: false, reason: 'timeout', message: UI.appConnectTimeout, ...(name ? { values: { name } } : {}) }), timeoutMs)
  })
  try {
    return await Promise.race([
      start.then(
        (r) => connectStartOutcomeOf(r, name),
        (e: unknown) => connectThrewOutcome(e, name)
      ),
      expired
    ])
  } finally {
    clear(timer)
  }
}

/**
 * Il tempo massimo del daemon sull'avvio (millisecondi). Di serie sta SOTTO
 * quello della riga, così la risposta del daemon — col motivo vero — arriva
 * prima dell'avviso generico. La sonda lo accorcia con
 * SANDBOT_TEST_APP_CONNECT_TIMEOUT_MS, SOLO insieme a SANDBOT_TEST_USER_DATA
 * (come le altre SANDBOT_TEST_*: in produzione non esiste); un valore non
 * valido non conta, uno più lungo del tempo della riga viene tagliato.
 */
export function appStartTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SANDBOT_TEST_USER_DATA ? env.SANDBOT_TEST_APP_CONNECT_TIMEOUT_MS : undefined
  const asked = raw ? Number(raw) : NaN
  if (!Number.isFinite(asked) || asked <= 0) return APP_CONNECT_DAEMON_TIMEOUT_MS
  return Math.min(asked, APP_CONNECT_MAX_MS)
}
