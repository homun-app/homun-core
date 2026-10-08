/**
 * Engine Plugins REST API client.
 * Connects directly to /v1/plugins for discovery and lifecycle management.
 */

import { ENGINE_DEFAULT_BASE_URL, EngineUnavailableError } from "./engine-client.ts";
import { homunErrorFromHttp } from "./homun-errors.ts";

export type EnginePluginSummaryItem = {
  name: string;
  version: string;
  kind: string;
  enabled: boolean;
  error?: string | null | undefined;
  tools: string[];
  hooks: string[];
};

export type EnginePluginsSummary = {
  plugins_count: number;
  enabled_count: number;
  tools_count: number;
  hooks_count: number;
  panels_count: number;
  commands_count: number;
  plugins: EnginePluginSummaryItem[];
};

export type PluginActionResult = {
  success: boolean;
  name: string;
  message: string;
};

async function pluginsFetch(path: string, init: RequestInit, baseUrl: string): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, init);
  } catch (cause) {
    throw new EngineUnavailableError(
      `Engine unreachable at ${baseUrl}. Start it with: npm run engine:dev`,
      cause,
    );
  }
}

async function readError(response: Response, fallback: string): Promise<never> {
  const body = await response.json().catch(() => null);
  throw homunErrorFromHttp(response.status, body, fallback);
}

export async function listEnginePlugins(
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<EnginePluginsSummary> {
  const response = await pluginsFetch(
    "/v1/plugins",
    { method: "GET", headers: { Accept: "application/json" } },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `List plugins failed with HTTP ${response.status}`);
  }
  return (await response.json()) as EnginePluginsSummary;
}

export async function enableEnginePlugin(
  name: string,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<PluginActionResult> {
  const response = await pluginsFetch(
    `/v1/plugins/${encodeURIComponent(name)}/enable`,
    { method: "POST", headers: { Accept: "application/json" } },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Enable plugin failed with HTTP ${response.status}`);
  }
  return (await response.json()) as PluginActionResult;
}

export async function disableEnginePlugin(
  name: string,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<PluginActionResult> {
  const response = await pluginsFetch(
    `/v1/plugins/${encodeURIComponent(name)}/disable`,
    { method: "POST", headers: { Accept: "application/json" } },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Disable plugin failed with HTTP ${response.status}`);
  }
  return (await response.json()) as PluginActionResult;
}
