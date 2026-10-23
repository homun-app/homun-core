/**
 * UNA sola sonda dello stato del motore per tutta l'app.
 *
 * Prima ogni `useEngineStatus()` faceva un proprio giro health+capabilities
 * ogni 4 s: con dieci componenti montati il browser produceva centinaia di
 * richieste al minuto in coppia. Qui c'è un unico sondatore per base URL:
 *
 * - UNA coppia health+capabilities ogni STATUS_POLL_INTERVAL_MS (≥ 10 s),
 *   sempre insieme: la coppia costa una sola iterazione e le capabilities si
 *   muovono insieme alla salute del motore;
 * - in pausa quando la scheda è nascosta (nessuna richiesta a motore spento
 *   per nessuno che guarda); alla riapertura della scheda si sondato subito;
 * - `everConnected`: questa sessione ha visto il motore raggiungibile almeno
 *   una volta (chi distingue una caduta da un avvio a motore freddo);
 * - `refresh()`: sonda immediata per chi preme «Riprova».
 *
 * Gli stati sono condivisi: mai inventare un successo quando il processo è
 * spento, mai nascondere una caduta.
 */
import {
  ENGINE_DEFAULT_BASE_URL,
  type EngineCapabilities,
  type EngineHealth,
  fetchEngineCapabilities,
  fetchEngineHealth,
} from "./engine-client.ts";

/** Invariante del budget richieste: mai più frequenti di ogni 10 secondi. */
export const STATUS_POLL_INTERVAL_MS = 10_000;

export type EngineConnectionState = "checking" | "connected" | "absent";

export type EngineStatusSnapshot = {
  connection: EngineConnectionState;
  /** Vero quando questa sessione ha visto il motore raggiungibile ALMENO una volta. */
  everConnected: boolean;
  health: EngineHealth | null;
  capabilities: EngineCapabilities | null;
  error: string | null;
};

const INITIAL_SNAPSHOT: EngineStatusSnapshot = {
  connection: "checking",
  everConnected: false,
  health: null,
  capabilities: null,
  error: null,
};

class EngineStatusStore {
  private snapshot: EngineStatusSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private readonly controller = new AbortController();
  private readonly baseUrl: string;

  constructor(baseUrl: string = ENGINE_DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  getSnapshot = (): EngineStatusSnapshot => this.snapshot;

  /** Sonda immediata (il «Riprova» della persona, la riapertura della scheda). */
  refresh = (): void => {
    void this.probe();
  };

  private start(): void {
    document.addEventListener("visibilitychange", this.onVisibility);
    void this.probe();
    this.schedule();
  }

  private stop(): void {
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.clearTimer();
  }

  private onVisibility = (): void => {
    // Nascosto: in pausa (si riparte al ritorno). Visibile: subito una sonda.
    if (document.visibilityState === "visible") void this.probe();
    this.schedule();
  };

  private schedule(): void {
    this.clearTimer();
    if (document.visibilityState !== "visible") return;
    this.timer = setInterval(() => void this.probe(), STATUS_POLL_INTERVAL_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async probe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const health = await fetchEngineHealth(this.baseUrl, this.controller.signal);
      const capabilities = await fetchEngineCapabilities(this.baseUrl, this.controller.signal);
      this.publish({
        connection: "connected",
        everConnected: true,
        health,
        capabilities,
        error: null,
      });
    } catch (cause) {
      if (this.controller.signal.aborted) return;
      this.publish({
        connection: "absent",
        everConnected: this.snapshot.everConnected,
        health: null,
        capabilities: null,
        error: cause instanceof Error ? cause.message : "Engine unavailable",
      });
    } finally {
      this.probing = false;
    }
  }

  private publish(next: EngineStatusSnapshot): void {
    const current = this.snapshot;
    if (
      current.connection === next.connection &&
      current.everConnected === next.everConnected &&
      current.health === next.health &&
      current.capabilities === next.capabilities &&
      current.error === next.error
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

const stores = new Map<string, EngineStatusStore>();

/** Il sondatore condiviso per questa base URL (uno per il motore locale). */
export function engineStatusStore(baseUrl: string = ENGINE_DEFAULT_BASE_URL): EngineStatusStore {
  let store = stores.get(baseUrl);
  if (!store) {
    store = new EngineStatusStore(baseUrl);
    stores.set(baseUrl, store);
  }
  return store;
}
