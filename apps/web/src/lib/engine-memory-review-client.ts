/**
 * Client for Engine Memory Review & Deduplication (preview and prune).
 */

import { ENGINE_DEFAULT_BASE_URL, EngineUnavailableError } from "./engine-client.ts";
import { DEFAULT_WORKSPACE_ID } from "./engine-domain-client.ts";
import { homunErrorFromHttp } from "./homun-errors.ts";

export type MemoryDuplicateCandidate = {
  id: string;
  text: string;
  similarity: number;
  created_at: string;
};

export type MemoryDuplicateCluster = {
  canonical_id: string;
  canonical_text: string;
  canonical_created_at: string;
  redundant_notes: MemoryDuplicateCandidate[];
  max_similarity: number;
};

export type MemoryReviewReport = {
  status: "preview" | "pruned";
  action: "preview" | "prune";
  total_reviewed: number;
  duplicate_clusters: number;
  pruned_count?: number;
  pruned_ids?: string[];
  candidates: MemoryDuplicateCluster[];
};

export type MemoryReviewOptions = {
  action?: "preview" | "prune";
  minSimilarity?: number;
  projectId?: string | null | undefined;
  query?: string | undefined;
  limit?: number;
  actorId?: string;
  workspaceId?: string;
  baseUrl?: string;
};

export async function reviewEngineMemories(
  options: MemoryReviewOptions = {},
): Promise<MemoryReviewReport> {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const baseUrl = options.baseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/memories/review`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.actorId) {
    headers["x-homun-actor-id"] = options.actorId;
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: options.action || "preview",
        min_similarity: options.minSimilarity ?? 0.75,
        project_id: options.projectId || null,
        query: options.query || null,
        limit: options.limit ?? 20,
      }),
    });
  } catch (cause) {
    throw new EngineUnavailableError(
      `Engine unreachable at ${baseUrl}. Start it with: npm run engine:dev`,
      cause,
    );
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, body, "Failed to review memories");
  }

  return (await response.json()) as MemoryReviewReport;
}
