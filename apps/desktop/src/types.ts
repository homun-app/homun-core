import type { LucideIcon } from "lucide-react";

export type ViewId =
  | "chat"
  | "learning"
  | "tasks"
  | "memory"
  | "connections"
  | "automations"
  | "proattivita"
  | "browser"
  | "brain"
  | "settings";

export type SettingsSectionId =
  | "account"
  | "general"
  | "appearance"
  | "runtime"
  | "privacy"
  | "memory"
  | "contacts"
  | "channels"
  | "connections"
  | "skills"
  | "computer";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_user_approval"
  | "waiting_resource"
  | "completed"
  | "failed";

export type Priority = "critical" | "high" | "normal" | "low" | "background";

export interface NavItem {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  badge?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
  metadata?: string;
  /** Model that actually produced THIS message (per-message override or the
   *  default for that turn). Footer shows it instead of the global active model. */
  model?: string;
  metrics?: ChatMessageMetrics;
  feedback?: "useful" | "not_useful";
  savedMemoryRef?: string;
  linkedTaskId?: string;
  linkedAutomationRef?: string;
  attachments?: ChatAttachment[];
}

export interface ChatMessageMetrics {
  promptTokens: number;
  generationTokens: number;
  promptTps: number;
  generationTps: number;
  peakMemoryGb: number;
  elapsedSeconds: number;
  maxTokens: number;
  promptBuildSeconds?: number;
  timeToFirstTokenSeconds?: number;
  totalElapsedSeconds?: number;
  runtimeStatusBefore?: string;
}

export interface ChatAttachment {
  artifactId: string;
  title: string;
  kind: "image" | "text" | "file";
  sizeBytes: number;
  previewAvailable: boolean;
  privacyDomain: string;
  /** Inline data-URL preview for images pasted/dropped into the composer. */
  previewUrl?: string;
}

export interface ChatThread {
  threadId: string;
  title: string;
  subtitle: string;
  status: "active" | "archived";
  pinned: boolean;
  computerSessionId: string;
  taskId: string;
  updatedAt: string;
  messageCount: number;
  /** Channel origin ("whatsapp"/"telegram") or null for an in-app chat. */
  source?: string | null;
}

export interface BrainStep {
  id: string;
  label: string;
  status: "done" | "running" | "queued";
  detail: string;
}

export interface BrainRunDetail {
  requestId: string;
  route: string;
  status: string;
  plannerRounds: number;
  loadedTools: number;
  memoryRefs: string[];
  contextBudget: ContextBudgetMetric[];
  steps: BrainStep[];
}

export interface ContextBudgetMetric {
  label: string;
  compressed: boolean;
  redacted: boolean;
  inputChars: number;
  outputChars: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  compressionRatio: number;
  redactionCount: number;
}

export interface TaskItem {
  id: string;
  title: string;
  kind: string;
  status: TaskStatus;
  priority: Priority;
  resource: string;
  risk: "low" | "medium" | "high";
  updated: string;
  blockedReason?: string;
}

export interface TaskResourceUsage {
  resourceClass: string;
  units: number;
}

export interface TaskDetailItem {
  taskId: string;
  kind: string;
  goal: string;
  status: TaskStatus;
  priority: Priority;
  blockedReason?: string;
  checkpointSummary: string;
  metadataSummary: string;
  exposesRawInput: boolean;
}

export type ComputerSurfaceKind = "browser" | "shell" | "files" | "logs";

export interface ComputerSurface {
  id: ComputerSurfaceKind;
  label: string;
  status: "idle" | "running" | "waiting" | "done";
  detail: string;
}

export interface ComputerTimelineItem {
  id: string;
  surface: ComputerSurfaceKind;
  title: string;
  detail: string;
  status: "done" | "running" | "waiting";
  timestamp: string;
  markdown?: string;
}

export interface ComputerArtifact {
  id: string;
  name: string;
  kind: "screenshot" | "terminal" | "file" | "log";
  detail: string;
  previewRef?: string;
}

export interface ComputerSession {
  id: string;
  title: string;
  subtitle: string;
  status: "running" | "waiting_user" | "paused" | "completed";
  activeSurface: ComputerSurfaceKind;
  elapsed: string;
  progressCurrent: number;
  progressTotal: number;
  previewTitle: string;
  previewDetail: string;
  previewArtifactId?: string;
  terminalExcerpt: string[];
  operationalPlanMarkdown?: string;
  surfaces: ComputerSurface[];
  timeline: ComputerTimelineItem[];
  artifacts: ComputerArtifact[];
  source?: "mock" | "core" | "loading" | "unavailable";
}

export interface ApprovalItem {
  id: string;
  title: string;
  reason: string;
  action: string;
  boundary: string;
  risk: "medium" | "high";
  requestedBy: string;
  scopeOptions?: Array<"once" | "always">;
  browserVisibilityOptions?: Array<"auto" | "visible" | "headless">;
  defaultBrowserVisibility?: "auto" | "visible" | "headless";
}

export interface RuntimeHealth {
  label: string;
  status: "ready" | "running" | "attention";
  detail: string;
}

export interface RuntimeControl {
  processId: string;
  label: string;
  status: string;
  port?: number;
  portOwnerPid?: number;
  duplicateCount: number;
  totalMemoryMb?: number;
  availableMemoryMb?: number;
  memoryMb?: number;
  cpuPercent?: number;
  message: string;
}

export interface RuntimeLogLine {
  stream: string;
  line: string;
}

export interface RuntimeLogs {
  processId: string;
  source: string;
  entries: RuntimeLogLine[];
  message: string;
}

export interface MemorySummary {
  confirmed: number;
  candidates: number;
  domains: Array<{ label: string; count: number }>;
}

export interface LearningInsight {
  id: string;
  title: string;
  summary: string;
  domain: string;
  cadence: string;
  confidence: number;
  status: "confirmed" | "candidate" | "needs_review";
  evidence: string[];
}

export interface AutomationProposal {
  id: string;
  title: string;
  summary: string;
  trigger: string;
  actions: string[];
  autonomyLevel: number;
  risk: "low" | "medium" | "high";
  status: "ready" | "needs_connector" | "needs_approval";
}

export interface ConnectionItem {
  id: string;
  name: string;
  type: "native" | "mcp" | "managed" | "skill";
  status: "connected" | "available" | "disabled";
  description: string;
}
