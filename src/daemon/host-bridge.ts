// HostBridge: le API che nel processo Electron vivevano nel main (notifiche
// native, safeStorage, screen) qui passano da un bridge — con la UI aperta
// diventano RPC verso il main Electron, senza UI degradano in modo doc:
// notifica via osascript, vault bloccato (mai chiavi in chiaro), scale factor
// retina di default (coerente con gli screenshot nativi 2x).
import { execFile } from 'node:child_process'
import { getAgent, getEntries } from '../main/store/db'
import { setScaleFactorProvider } from '../main/computeruse'
import { setSafeStorage, type SafeStorageLike } from '../main/vault'

/** notifica macOS senza Electron: display notification di osascript. */
export function osascriptNotify(title: string, body: string): void {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], () => undefined)
}

export interface HostBridgeDeps {
  /** RPC verso la UI; null/throw se la UI non è connessa. */
  callUi(method: string, params?: unknown[]): Promise<unknown>
  hasUi(): boolean
}

/** safeStorage proxy verso la UI: disponibile solo a finestra aperta. */
export function uiSafeStorage(deps: HostBridgeDeps): SafeStorageLike {
  return {
    isEncryptionAvailable: () => deps.hasUi(),
    encryptString: async (plain: string) => Buffer.from(String(await deps.callUi('host.safeStorage.encrypt', [plain])), 'base64'),
    decryptString: async (encrypted: Buffer) => String(await deps.callUi('host.safeStorage.decrypt', [encrypted.toString('base64')]))
  }
}

/**
 * Collega il bridge al runtime: safeStorage del vault, scale factor del
 * computer use (cache 60s), notifica "bot ha risposto".
 */
export function attachHostBridge(deps: HostBridgeDeps): { notifyDone(agentId: string): void; refreshScale(): void } {
  setSafeStorage(uiSafeStorage(deps))

  let scaleFactor = 2
  setScaleFactorProvider(() => scaleFactor)
  const refreshScale = (): void => {
    if (!deps.hasUi()) return
    deps.callUi('host.screen.scaleFactor')
      .then((v) => {
        if (typeof v === 'number' && v > 0) scaleFactor = v
      })
      .catch(() => undefined)
  }
  const refreshTimer = setInterval(refreshScale, 60_000)
  refreshTimer.unref()

  return {
    refreshScale,
    /** Chiamato a fine turno: notifica l'utente se non sta già guardando (la UI decide come). */
    notifyDone(agentId: string): void {
      const agent = getAgent(agentId)
      if (!agent) return
      const last = getEntries(agentId).findLast((e) => e.kind === 'message' && e.role === 'assistant')
      if (!last?.content) return
      const body = last.content.replace(/[#*`>]/g, '').slice(0, 120)
      if (deps.hasUi()) {
        void deps.callUi('host.notify', [agentId]).catch(() => osascriptNotify(`${agent.name} ha risposto`, body))
      } else {
        osascriptNotify(`${agent.name} ha risposto`, body)
      }
    }
  }
}
