export interface ProviderConfig {
  apiKey: string
  baseUrl?: string
  [key: string]: unknown
}

export interface UnifiedMessage {
  role: "user" | "assistant"
  content: string
  timestamp?: string
  speaker?: string
}

export interface UnifiedSession {
  sessionId: string
  messages: UnifiedMessage[]
  metadata?: Record<string, unknown>
}

export interface IngestOptions {
  containerTag: string
  metadata?: Record<string, unknown>
}

export interface SearchOptions {
  containerTag: string
  limit?: number
  threshold?: number
}

export interface IngestResult {
  documentIds: string[]
  taskIds?: string[]
}

export interface IndexingProgress {
  completedIds: string[]
  failedIds: string[]
  total: number
}

export type IndexingProgressCallback = (progress: IndexingProgress) => void

export interface Provider {
  name: string
  initialize(config: ProviderConfig): Promise<void>
  ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult>
  awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback,
  ): Promise<void>
  search(query: string, options: SearchOptions): Promise<unknown[]>
  clear(containerTag: string): Promise<void>
}

export interface HomunSearchResult {
  reference: string
  summary: string
  score: number
  sourceUserId: string
  sourceWorkspaceId: string
  sourceLabel: string
  status: "confirmed" | "candidate"
  memoryType: string
}
