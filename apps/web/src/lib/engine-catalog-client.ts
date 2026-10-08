/**
 * Client for Engine Skill Catalog Packs (F3.6 / H46).
 */

import { ENGINE_DEFAULT_BASE_URL, EngineUnavailableError } from "./engine-client.ts";
import { homunErrorFromHttp } from "./homun-errors.ts";

export type SkillPack = {
  id: string;
  name: string;
  description: string;
  version: string;
  skills: string[];
  installed: boolean;
  category?: string;
  author?: string;
};

async function catalogFetch(path: string, init?: RequestInit, baseUrl = ENGINE_DEFAULT_BASE_URL): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, init);
  } catch (cause) {
    throw new EngineUnavailableError(
      `Engine unreachable at ${baseUrl}. Start it with: npm run engine:dev`,
      cause,
    );
  }
}

export async function fetchCatalogPacks(baseUrl = ENGINE_DEFAULT_BASE_URL): Promise<SkillPack[]> {
  const response = await catalogFetch("/v1/catalog/packs", undefined, baseUrl);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, body, "Failed to list catalog packs");
  }
  return (await response.json()) as SkillPack[];
}

export async function installCatalogPack(packId: string, baseUrl = ENGINE_DEFAULT_BASE_URL): Promise<SkillPack> {
  const response = await catalogFetch("/v1/catalog/packs/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pack_id: packId }),
  }, baseUrl);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, body, "Failed to install catalog pack");
  }
  return (await response.json()) as SkillPack;
}

export async function uninstallCatalogPack(packId: string, baseUrl = ENGINE_DEFAULT_BASE_URL): Promise<{ success: boolean; pack_id: string }> {
  const response = await catalogFetch("/v1/catalog/packs/uninstall", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pack_id: packId }),
  }, baseUrl);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, body, "Failed to uninstall catalog pack");
  }
  return (await response.json()) as { success: boolean; pack_id: string };
}
