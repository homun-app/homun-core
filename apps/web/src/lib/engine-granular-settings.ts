/**
 * Client storage and helpers for granular Hermes-parity engine settings.
 * Manages fine-grained provider parameters (temperature, thinking, top_p, timeouts)
 * and engine maintenance/diagnostics configurations.
 */

export type ProviderGranularConfig = {
  temperature: number;
  reasoningEffort: "none" | "low" | "medium" | "high";
  maxTokens: number;
  topP: number;
  stream: boolean;
  timeoutSeconds: number;
  customHeaders: string;
};

export const DEFAULT_PROVIDER_GRANULAR_CONFIG: ProviderGranularConfig = {
  temperature: 0.7,
  reasoningEffort: "medium",
  maxTokens: 8192,
  topP: 1.0,
  stream: true,
  timeoutSeconds: 60,
  customHeaders: "",
};

export type EngineDiagnosticsConfig = {
  logLevel: "DEBUG" | "INFO" | "WARNING" | "ERROR";
  memoryCompactionThreshold: number;
  memorySearchTopK: number;
  autoPruneStaleDays: number;
  toolTimeoutSeconds: number;
  autoApproveReadOnly: boolean;
};

export const DEFAULT_ENGINE_DIAGNOSTICS_CONFIG: EngineDiagnosticsConfig = {
  logLevel: "INFO",
  memoryCompactionThreshold: 16000,
  memorySearchTopK: 6,
  autoPruneStaleDays: 30,
  toolTimeoutSeconds: 45,
  autoApproveReadOnly: true,
};

const PROVIDER_CONFIG_KEY_PREFIX = "homun_provider_options_";
const ENGINE_DIAGNOSTICS_KEY = "homun_engine_diagnostics_config";

export function getProviderGranularConfig(providerId: string): ProviderGranularConfig {
  try {
    const raw = localStorage.getItem(`${PROVIDER_CONFIG_KEY_PREFIX}${providerId}`);
    if (!raw) return { ...DEFAULT_PROVIDER_GRANULAR_CONFIG };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_PROVIDER_GRANULAR_CONFIG,
      ...parsed,
    };
  } catch {
    return { ...DEFAULT_PROVIDER_GRANULAR_CONFIG };
  }
}

export function setProviderGranularConfig(
  providerId: string,
  cfg: Partial<ProviderGranularConfig>,
): ProviderGranularConfig {
  const current = getProviderGranularConfig(providerId);
  const updated = { ...current, ...cfg };
  try {
    localStorage.setItem(
      `${PROVIDER_CONFIG_KEY_PREFIX}${providerId}`,
      JSON.stringify(updated),
    );
  } catch {
    // ignore quota errors in private browsing
  }
  return updated;
}

export function getEngineDiagnosticsConfig(): EngineDiagnosticsConfig {
  try {
    const raw = localStorage.getItem(ENGINE_DIAGNOSTICS_KEY);
    if (!raw) return { ...DEFAULT_ENGINE_DIAGNOSTICS_CONFIG };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_ENGINE_DIAGNOSTICS_CONFIG,
      ...parsed,
    };
  } catch {
    return { ...DEFAULT_ENGINE_DIAGNOSTICS_CONFIG };
  }
}

export function setEngineDiagnosticsConfig(
  cfg: Partial<EngineDiagnosticsConfig>,
): EngineDiagnosticsConfig {
  const current = getEngineDiagnosticsConfig();
  const updated = { ...current, ...cfg };
  try {
    localStorage.setItem(ENGINE_DIAGNOSTICS_KEY, JSON.stringify(updated));
  } catch {
    // ignore
  }
  return updated;
}
