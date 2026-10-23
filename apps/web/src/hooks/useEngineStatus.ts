import { useCallback, useSyncExternalStore } from "react";
import {
  ENGINE_DEFAULT_BASE_URL,
  type EngineCapabilities,
  type EngineDataSource,
  type EngineHealth,
  readEngineDataSource,
  subscribeEngineDataSource,
  writeEngineDataSource,
} from "../lib/engine-client";
import {
  engineStatusServerSnapshot,
  engineStatusStore,
  type EngineConnectionState,
} from "../lib/engine-status-store";

export type { EngineConnectionState };

export type EngineStatus = {
  connection: EngineConnectionState;
  /** Vero quando questa sessione ha visto il motore raggiungibile ALMENO una volta. */
  everConnected: boolean;
  health: EngineHealth | null;
  capabilities: EngineCapabilities | null;
  error: string | null;
  dataSource: EngineDataSource;
  setDataSource: (source: EngineDataSource) => void;
  refresh: () => void;
};

/**
 * Lo stato del motore, letto dall'UNICO sondatore condiviso: una coppia
 * health+capabilities ogni STATUS_POLL_INTERVAL_MS con la scheda visibile,
 * in pausa quando è nascosta. Ogni componente che ne ha bisogno si abbona;
 * dieci abbonati restano dieci letture, non dieci sondatori.
 */
export function useEngineStatus(baseUrl: string = ENGINE_DEFAULT_BASE_URL): EngineStatus {
  const store = engineStatusStore(baseUrl);
  const status = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    engineStatusServerSnapshot,
  );
  const dataSource = useSyncExternalStore(
    subscribeEngineDataSource,
    readEngineDataSource,
    () => "engine" as const,
  );
  const refresh = useCallback(() => store.refresh(), [store]);
  return {
    connection: status.connection,
    everConnected: status.everConnected,
    health: status.health,
    capabilities: status.capabilities,
    error: status.error,
    dataSource,
    setDataSource: (source) => {
      writeEngineDataSource(source);
    },
    refresh,
  };
}
