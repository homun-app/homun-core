import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ENGINE_DEFAULT_BASE_URL,
  type EngineCapabilities,
  type EngineDataSource,
  type EngineHealth,
  fetchEngineCapabilities,
  fetchEngineHealth,
  readEngineDataSource,
  writeEngineDataSource,
  subscribeEngineDataSource,
} from "../lib/engine-client";

export type EngineConnectionState = "checking" | "connected" | "absent";

export type EngineStatus = {
  connection: EngineConnectionState;
  health: EngineHealth | null;
  capabilities: EngineCapabilities | null;
  error: string | null;
  dataSource: EngineDataSource;
  setDataSource: (source: EngineDataSource) => void;
  refresh: () => void;
};

const POLL_MS = 4000;

export function useEngineStatus(baseUrl: string = ENGINE_DEFAULT_BASE_URL): EngineStatus {
  const [connection, setConnection] = useState<EngineConnectionState>("checking");
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [capabilities, setCapabilities] = useState<EngineCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dataSource = useSyncExternalStore(subscribeEngineDataSource, readEngineDataSource, () => "engine" as const);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function probe() {
      try {
        const nextHealth = await fetchEngineHealth(baseUrl, controller.signal);
        const nextCapabilities = await fetchEngineCapabilities(baseUrl, controller.signal);
        if (cancelled) {
          return;
        }
        setHealth(nextHealth);
        setCapabilities(nextCapabilities);
        setError(null);
        setConnection("connected");
      } catch (cause) {
        if (cancelled || controller.signal.aborted) {
          return;
        }
        setHealth(null);
        setCapabilities(null);
        setConnection("absent");
        setError(cause instanceof Error ? cause.message : "Engine unavailable");
      }
    }

    void probe();
    const timer = window.setInterval(() => {
      void probe();
    }, POLL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [baseUrl, tick]);

  return {
    connection,
    health,
    capabilities,
    error,
    dataSource,
    setDataSource: (source) => {
      writeEngineDataSource(source);
    },
    refresh: () => setTick((value) => value + 1),
  };
}
