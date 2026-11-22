// V3 (fase stato-vivo): la nota U5 arriva anche quando un server ESISTENTE
// cambia stato. Il daemon ricorda in settings (niente tabelle nuove) l'ULTIMO
// STATO NOTIFICATO di ogni server ai bot abilitati: all'avvio e a ogni test
// periodico, se cambia — mai notificato, si ripara, si rompe — parte la nota,
// UNA volta sola per cambio. È il caso dell'aggiornamento che ripara un
// server (i server importati con la beta.15, prima di U5, funzionavano ma la
// nota non è mai arrivata: partiva solo su import/aggiunta/modifica).
import type { McpServerConfig } from '../main/mcp'
import type { McpErrorCategory } from '../main/mcp/error-category'
import { getSetting, setSetting } from '../main/store/db'

/** Il setting che ricorda l'ultimo stato notificato di ogni server (id → 'ok' | 'fail'). */
export const NOTIFIED_STATE_SETTING = 'mcp.serverNotifiedState'

/** Lo stato notificato di un server: funziona ('ok') o non parte ('fail'). */
export type NotifiedServerState = 'ok' | 'fail'

/**
 * V3: ricorda l'ultimo stato NOTIFICATO di un server — la scrive
 * notifyMcpServerState dopo ogni nota (mcp:save, card, sync), così l'avvio e
 * il test periodico non ri-notificano quello che il bot sa già.
 */
export function recordNotifiedServerState(id: string, state: NotifiedServerState): void {
  setSetting(NOTIFIED_STATE_SETTING, { ...getSetting<Record<string, NotifiedServerState>>(NOTIFIED_STATE_SETTING, {}), [id]: state })
}

/** L'esito di un test di connessione, come lo produce testServer. */
export interface McpStateTestResult {
  ok: boolean
  tools?: string[]
  error?: string
  category?: McpErrorCategory
}

/** Le dipendenze del sync, iniettabili per i test (il default parla col modulo mcp vero). */
export interface McpStateSyncDeps {
  listServers: () => McpServerConfig[]
  testServer: (id: string) => Promise<McpStateTestResult>
  notify: (cfg: McpServerConfig, test: McpStateTestResult, emit: unknown, worker: unknown) => Promise<void>
  getNotified: () => Record<string, NotifiedServerState>
  setNotified: (states: Record<string, NotifiedServerState>) => void
}

/**
 * V3 (fase stato-vivo): controlla i server ACCESI (i needsAuth aspettano i
 * valori dell'utente, U7) e per ognuno confronta l'esito del test con
 * l'ultimo stato NOTIFICATO: se cambia — mai notificato, si ripara, si rompe
 * — manda la nota U5 ai bot abilitati (la filtra notifyMcpServerState con
 * enabledFor) e ricorda il nuovo stato. Nessuna raffica: uno stato uguale non
 * nota; una nota fallita non si segna (il prossimo giro la riprova).
 */
export async function syncMcpServerStates(deps: McpStateSyncDeps, emit: unknown, worker: unknown): Promise<{ checked: number; notes: number }> {
  const notified = { ...deps.getNotified() }
  let checked = 0
  let notes = 0
  for (const cfg of deps.listServers()) {
    if (!cfg.enabled || cfg.needsAuth) continue
    checked++
    let test: McpStateTestResult
    try {
      test = await deps.testServer(cfg.id)
    } catch (e) {
      test = { ok: false, error: e instanceof Error ? e.message : String(e), category: 'unknown-error' }
    }
    const now: NotifiedServerState = test.ok ? 'ok' : 'fail'
    if (notified[cfg.id] === now) continue
    try {
      await deps.notify(cfg, test, emit, worker)
    } catch {
      // la nota non è partita: lo stato NON si segna, il prossimo giro riprova
      continue
    }
    notified[cfg.id] = now
    notes++
  }
  deps.setNotified(notified)
  return { checked, notes }
}
