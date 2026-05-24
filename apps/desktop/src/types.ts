import type { LucideIcon } from "lucide-react";

export type ViewId =
  | "chat"
  | "learning"
  | "tasks"
  | "memory"
  | "connections"
  | "automations"
  | "browser"
  | "brain"
  | "settings";

export type SettingsSectionId =
  | "general"
  | "privacy"
  | "runtime"
  | "connections"
  | "audit";

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
}

export interface ChatThread {
  threadId: string;
  title: string;
  subtitle: string;
  status: "active" | "archived";
  computerSessionId: string;
  taskId: string;
  updatedAt: string;
  messageCount: number;
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
  steps: BrainStep[];
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
}

export interface ComputerArtifact {
  id: string;
  name: string;
  kind: "screenshot" | "terminal" | "file" | "log";
  detail: string;
}

export interface ComputerSession {
  id: string;
  title: string;
  subtitle: string;
  status: "running" | "waiting_user" | "completed";
  activeSurface: ComputerSurfaceKind;
  elapsed: string;
  progressCurrent: number;
  progressTotal: number;
  previewTitle: string;
  previewDetail: string;
  terminalExcerpt: string[];
  surfaces: ComputerSurface[];
  timeline: ComputerTimelineItem[];
  artifacts: ComputerArtifact[];
  source?: "mock" | "core" | "loading" | "unavailable";
}

export interface ApprovalItem {
  id: string;
  title: string;
  reason: string;
  risk: "medium" | "high";
  requestedBy: string;
}

export interface RuntimeHealth {
  label: string;
  status: "ready" | "running" | "attention";
  detail: string;
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
