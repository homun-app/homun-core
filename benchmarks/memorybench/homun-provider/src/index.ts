import type {
  HomunSearchResult,
  IndexingProgressCallback,
  IngestOptions,
  IngestResult,
  Provider,
  ProviderConfig,
  SearchOptions,
  UnifiedSession,
} from "./types.ts"

const DEFAULT_BASE_URL = "http://127.0.0.1:18765"
const DEFAULT_POLL_MS = 250
const DEFAULT_TIMEOUT_MS = 120_000

interface HomunIngestResponse {
  workspace_id: string
  document_ids: string[]
  task_ids?: string[]
}

interface HomunIndexStatus {
  completed_ids: string[]
  failed_ids: string[]
  total: number
  pending: boolean
}

interface HomunSearchResponse {
  results: Array<{
    reference: string
    summary: string
    score: number
    source_user_id: string
    source_workspace_id: string
    source_label: string
    status: "confirmed" | "candidate"
    memory_type: string
  }>
}

export class HomunProvider implements Provider {
  name = "homun"
  concurrency = { default: 8, ingest: 1, indexing: 4 }
  private baseUrl: URL | null = null
  private token = ""
  private pollMs = DEFAULT_POLL_MS
  private timeoutMs = DEFAULT_TIMEOUT_MS
  private readonly workspaces = new Map<string, string>()

  async initialize(config: ProviderConfig): Promise<void> {
    const baseUrl = new URL(config.baseUrl || DEFAULT_BASE_URL)
    assertLoopbackUrl(baseUrl)
    this.baseUrl = baseUrl
    this.token = config.apiKey.trim()
    if (!this.token) throw new Error("Homun gateway token is required")
    this.pollMs = positiveNumber(config.pollMs, DEFAULT_POLL_MS)
    this.timeoutMs = positiveNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    assertContainerTag(options.containerTag)
    const response = await this.request<HomunIngestResponse>("/api/memory/bench/ingest", {
      method: "POST",
      body: JSON.stringify({
        container_tag: options.containerTag,
        sessions,
        metadata: options.metadata || {},
      }),
    })
    this.workspaces.set(options.containerTag, response.workspace_id)
    return {
      documentIds: response.document_ids,
      ...(response.task_ids ? { taskIds: response.task_ids } : {}),
    }
  }

  async awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback,
  ): Promise<void> {
    assertContainerTag(containerTag)
    if (result.documentIds.length === 0) {
      onProgress?.({ completedIds: [], failedIds: [], total: 0 })
      return
    }
    const startedAt = Date.now()
    while (true) {
      const status = await this.request<HomunIndexStatus>("/api/memory/bench/status", {
        method: "POST",
        body: JSON.stringify({
          container_tag: containerTag,
          document_ids: result.documentIds,
        }),
      })
      onProgress?.({
        completedIds: [...status.completed_ids],
        failedIds: [...status.failed_ids],
        total: status.total,
      })
      if (!status.pending) {
        if (status.failed_ids.length > 0) {
          throw new Error(`Homun indexing failed for ${status.failed_ids.length} document(s)`)
        }
        return
      }
      if (Date.now() - startedAt >= this.timeoutMs) {
        throw new Error("Timed out waiting for Homun memory indexing")
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs))
    }
  }

  async search(query: string, options: SearchOptions): Promise<HomunSearchResult[]> {
    assertContainerTag(options.containerTag)
    const workspaceId = this.workspaces.get(options.containerTag)
    if (!workspaceId) throw new Error("Container has not been ingested by this provider")
    const response = await this.request<HomunSearchResponse>("/api/memory/bench/search", {
      method: "POST",
      body: JSON.stringify({
        container_tag: options.containerTag,
        workspace_id: workspaceId,
        query,
        limit: options.limit || 30,
        threshold: options.threshold ?? 0.3,
      }),
    })
    return response.results.map((result) => ({
      reference: result.reference,
      summary: result.summary,
      score: result.score,
      sourceUserId: result.source_user_id,
      sourceWorkspaceId: result.source_workspace_id,
      sourceLabel: result.source_label,
      status: result.status,
      memoryType: result.memory_type,
    }))
  }

  async clear(containerTag: string): Promise<void> {
    assertContainerTag(containerTag)
    const workspaceId = this.workspaces.get(containerTag)
    if (!workspaceId) return
    await this.request(`/api/workspaces/${encodeURIComponent(workspaceId)}/delete`, {
      method: "POST",
    })
    this.workspaces.delete(containerTag)
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    if (!this.baseUrl) throw new Error("Provider not initialized")
    const url = new URL(path, this.baseUrl)
    const headers = new Headers(init.headers)
    headers.set("content-type", "application/json")
    if (this.token) headers.set("authorization", `Bearer ${this.token}`)
    const response = await fetch(url, { ...init, headers })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Homun gateway ${response.status}: ${detail.slice(0, 240)}`)
    }
    return (await response.json()) as T
  }
}

function assertLoopbackUrl(url: URL): void {
  const hostname = url.hostname.toLowerCase()
  const ipv4 = hostname.split(".")
  const ipv4Loopback =
    ipv4.length === 4 &&
    ipv4[0] === "127" &&
    ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    ipv4Loopback
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Homun MemoryBench accepts only an authenticated loopback gateway URL")
  }
}

function assertContainerTag(containerTag: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(containerTag)) {
    throw new Error("Invalid MemoryBench container tag")
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

export default HomunProvider
