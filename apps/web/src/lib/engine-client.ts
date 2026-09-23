/**
 * Loopback client for the Homun engine.
 * Never invents success when the process is down; never falls back to simulation.
 */

import { HomunClientError } from "./homun-errors.ts";

declare global {
  interface Window {
    homunDesktop?: Readonly<{
      engineBaseUrl: string;
      updateStatus?: () => Promise<{ current: string }>;
      updateCheck?: () => Promise<{ current: string; available: boolean; version: string | null; error?: string }>;
    }>;
  }
}
export const ENGINE_DEFAULT_BASE_URL =
  typeof window !== "undefined" && window.homunDesktop
    ? window.homunDesktop.engineBaseUrl
    : "http://127.0.0.1:8765";

export type EngineHealth = {
  status: "ok";
  version: string;
  uptime_seconds: number;
};

export type EngineCapabilityFlags = {
  domain: boolean;
  agents: boolean;
  materials: boolean;
  memory: boolean;
  automations: boolean;
  peers: boolean;
  backup: boolean;
  models: boolean;
};

export type EngineCapabilities = {
  api_version: string;
  version: string;
  features: EngineCapabilityFlags;
};

export type EngineDataSource = "simulation" | "engine";

/** @deprecated Prefer HomunClientError with code engine_unavailable */
export class EngineUnavailableError extends HomunClientError {
  constructor(message: string, cause?: unknown) {
    super("engine_unavailable", message, { cause, retryable: true });
    this.name = "EngineUnavailableError";
  }
}

/** @deprecated Prefer HomunClientError with code engine_capability_missing */
export class EngineCapabilityError extends HomunClientError {
  constructor(message: string) {
    super("engine_capability_missing", message, { retryable: false });
    this.name = "EngineCapabilityError";
  }
}

async function engineFetch(path: string, baseUrl: string, signal?: AbortSignal): Promise<Response> {
  try {
    const init: RequestInit = {
      method: "GET",
      headers: { Accept: "application/json" },
    };
    if (signal) {
      init.signal = signal;
    }
    return await fetch(`${baseUrl}${path}`, init);
  } catch (cause) {
    throw new EngineUnavailableError(
      `Engine unreachable at ${baseUrl}. Start it with: npm run engine:dev`,
      cause,
    );
  }
}

export async function fetchEngineHealth(
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
  signal?: AbortSignal,
): Promise<EngineHealth> {
  const response = await engineFetch("/v1/health", baseUrl, signal);
  if (!response.ok) {
    throw new EngineUnavailableError(`Engine health failed with HTTP ${response.status}`);
  }
  return (await response.json()) as EngineHealth;
}

export async function fetchEngineCapabilities(
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
  signal?: AbortSignal,
): Promise<EngineCapabilities> {
  const response = await engineFetch("/v1/capabilities", baseUrl, signal);
  if (!response.ok) {
    throw new EngineUnavailableError(`Engine capabilities failed with HTTP ${response.status}`);
  }
  return (await response.json()) as EngineCapabilities;
}

/**
 * Gate for real API calls. Simulation must be selected explicitly;
 * engine mode never silently falls back to demo data.
 */
export function assertEngineReadyForDomain(
  source: EngineDataSource,
  online: boolean,
  capabilities: EngineCapabilities | null,
): void {
  if (source === "simulation") {
    return;
  }
  if (!online) {
    throw new EngineUnavailableError(
      "Engine data source selected, but the engine is not connected. No silent fallback to simulation.",
    );
  }
  if (!capabilities?.features.domain) {
    throw new EngineCapabilityError(
      "Engine is connected, but domain capability is false. Real work APIs are not available yet.",
    );
  }
}

/**
 * Resolves which backend may serve workspace data.
 * Simulation and engine never mix silently.
 */
export function resolveWorkspaceBackend(
  source: EngineDataSource,
  online: boolean,
  capabilities: EngineCapabilities | null,
): "simulation" | "engine" {
  if (source === "simulation") {
    return "simulation";
  }
  assertEngineReadyForDomain(source, online, capabilities);
  return "engine";
}

/**
 * UI mode follows Fonte explicitly. When Fonte=motore but the engine is down,
 * stay on the engine path (empty list + gate error) — never fall back to Marta demo.
 */
export function resolveWorkspaceMode(
  source: EngineDataSource,
  online: boolean,
  capabilities: EngineCapabilities | null,
): { backend: "simulation" | "engine"; gateError: unknown; engineReady: boolean } {
  if (source === "simulation") {
    return { backend: "simulation", gateError: null, engineReady: false };
  }
  try {
    assertEngineReadyForDomain(source, online, capabilities);
    return { backend: "engine", gateError: null, engineReady: true };
  } catch (cause) {
    return { backend: "engine", gateError: cause, engineReady: false };
  }
}

export function readEngineDataSource(): EngineDataSource {
  if (typeof window === "undefined") {
    return "engine";
  }
  const value = window.localStorage.getItem("homun.engine.dataSource");
  // Default is engine (real path). Explicit "simulation" remains for deprecated demo access.
  if (value === "simulation") {
    return "simulation";
  }
  return "engine";
}

export function writeEngineDataSource(source: EngineDataSource): void {
  window.localStorage.setItem("homun.engine.dataSource", source);
  window.dispatchEvent(new Event("homun:engine-source"));
}

/** Notify every hook in this window and other tabs of an explicit source choice. */
export function subscribeEngineDataSource(listener: () => void): () => void {
  window.addEventListener("homun:engine-source", listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener("homun:engine-source", listener);
    window.removeEventListener("storage", listener);
  };
}
