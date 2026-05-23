import type { LucideIcon } from "lucide-react";

export type ViewId =
  | "chat"
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

export interface ConnectionItem {
  id: string;
  name: string;
  type: "native" | "mcp" | "managed" | "skill";
  status: "connected" | "available" | "disabled";
  description: string;
}
