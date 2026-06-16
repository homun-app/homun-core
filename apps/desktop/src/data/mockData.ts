import {
  Blocks,
  Bot,
  Brain,
  CalendarClock,
  CheckCircle2,
  Cpu,
  Database,
  GalleryVerticalEnd,
  Globe2,
  KeyRound,
  MessageSquare,
  Monitor,
  MonitorPlay,
  Palette,
  Plug,
  SlidersHorizontal,
  Sparkles,
  User,
  Users,
} from "lucide-react";
import type {
  ApprovalItem,
  AutomationProposal,
  BrainRunDetail,
  ChatMessage,
  ComputerSession,
  ConnectionItem,
  LearningInsight,
  MemorySummary,
  NavItem,
  RuntimeHealth,
  SettingsSectionId,
  TaskItem,
} from "../types";

// Static core nav. Plugin/addon entries (es. "Proattività") sono aggiunti a runtime
// dal registro in App.tsx in base allo stato abilitato (ADR 0011 §10-A): staccare
// l'addon ne fa sparire la voce di nav.
export const navItems: NavItem[] = [
  { id: "chat", label: "chat.newTask", icon: MessageSquare },
  // "Apprendimento" è confluito in Homun. "Memoria" è stata unificata nelle
  // Impostazioni → Memoria (un'unica superficie, fuori più pulito).
  // "Pianificato" (coda dei run) è confluito in Automazioni: la regola è la cosa
  // di prima classe; i run si vedono nei thread. Manteniamo l'icona-calendario.
  { id: "automations", label: "nav.automations", icon: CalendarClock },
];

export const chatMessages: ChatMessage[] = [
  {
    id: "m1",
    role: "assistant",
    text: "I'm ready. Write to me.",
    timestamp: "ora",
    metadata: "Local model",
  },
];

export const computerSession: ComputerSession = {
  id: "computer_active_prompt",
  title: "Local computer",
  subtitle: "Local session ready for prompt, shell and controlled browser",
  status: "running",
  activeSurface: "logs",
  elapsed: "0s",
  progressCurrent: 0,
  progressTotal: 3,
  previewTitle: "Local session",
  previewDetail: "Waiting for user prompt.",
  terminalExcerpt: [],
  surfaces: [
    {
      id: "browser",
      label: "Browser",
      status: "idle",
      detail: "Ready for controlled browser tasks",
    },
    {
      id: "shell",
      label: "Terminale",
      status: "idle",
      detail: "Ready for local checks",
    },
    {
      id: "files",
      label: "File",
      status: "idle",
      detail: "No artifacts yet",
    },
    {
      id: "logs",
      label: "Log",
      status: "running",
      detail: "Redacted prompt events",
    },
  ],
  timeline: [
    {
      id: "ready",
      surface: "logs",
      title: "Local session ready",
      detail: "Waiting for user prompt",
      status: "done",
      timestamp: "ora",
    },
  ],
  artifacts: [],
};

export const brainRun: BrainRunDetail = {
  requestId: "req_acme_morning",
  route: "mixed_workflow",
  status: "running",
  plannerRounds: 2,
  loadedTools: 5,
  memoryRefs: ["memory:user:workspace:acme", "memory:user:workspace:routine"],
  contextBudget: [
    {
      label: "memory_context",
      compressed: true,
      redacted: true,
      inputChars: 8420,
      outputChars: 1870,
      estimatedInputTokens: 2105,
      estimatedOutputTokens: 468,
      compressionRatio: 0.22,
      redactionCount: 2,
    },
    {
      label: "loaded_tool_details",
      compressed: true,
      redacted: false,
      inputChars: 5340,
      outputChars: 2980,
      estimatedInputTokens: 1335,
      estimatedOutputTokens: 745,
      compressionRatio: 0.56,
      redactionCount: 0,
    },
  ],
  steps: [
    {
      id: "context",
      label: "Load memory context",
      status: "done",
      detail: "2 redacted references",
    },
    {
      id: "tasks",
      label: "Read tasks and messages",
      status: "running",
      detail: "Immediate read-only tool",
    },
    {
      id: "review",
      label: "ReviewAgent",
      status: "queued",
      detail: "Durable subagent task",
    },
  ],
};

export const tasks: TaskItem[] = [
  {
    id: "task_prompt_session",
    title: "Active local prompt",
    kind: "local_prompt",
    status: "running",
    priority: "high",
    resource: "shell_process",
    risk: "low",
    updated: "1 min ago",
  },
  {
    id: "task_acme_summary",
    title: "Acme operational summary",
    kind: "subagent.ReviewAgent",
    status: "waiting_user_approval",
    priority: "normal",
    resource: "llm_inference",
    risk: "medium",
    updated: "3 min ago",
    blockedReason: "Confirmation needed before sending the summary to the team channel.",
  },
  {
    id: "task_memory_index",
    title: "Update project memory index",
    kind: "memory_indexing",
    status: "queued",
    priority: "background",
    resource: "memory_indexing",
    risk: "low",
    updated: "8 min ago",
  },
  {
    id: "task_provider_health",
    title: "Inference provider health check",
    kind: "process.health",
    status: "completed",
    priority: "low",
    resource: "background_maintenance",
    risk: "low",
    updated: "12 min ago",
  },
];

export const approvals: ApprovalItem[] = [
  {
    id: "approval_acme",
    title: "Send summary to Acme",
    reason: "write_with_confirmation action toward messaging connector.",
    action: "connector.write_with_confirmation",
    boundary: "team_messaging",
    risk: "medium",
    requestedBy: "ReviewAgent",
  },
];

export const runtimeHealth: RuntimeHealth[] = [
  { label: "Modello", status: "ready", detail: "Inference provider configured" },
  { label: "Browser", status: "running", detail: "Assistant profile active" },
  { label: "Task Runtime", status: "running", detail: "3 tasks queued" },
];

export const memorySummary: MemorySummary = {
  confirmed: 184,
  candidates: 12,
  domains: [
    { label: "work", count: 122 },
    { label: "personal", count: 38 },
    { label: "browser", count: 24 },
  ],
};

export const learningInsights: LearningInsight[] = [
  {
    id: "morning_project_start",
    title: "Often starts from the active project",
    summary:
      "When you start a work session you first ask for git status, open tasks and the next useful action.",
    domain: "work",
    cadence: "Morning, weekdays",
    confidence: 0.84,
    status: "confirmed",
    evidence: [
      "6 local sessions with project opening and task check",
      "3 consecutive requests prioritized status, plan and verification",
      "No raw data saved: only metadata and redacted references",
    ],
  },
  {
    id: "travel_compare_before_booking",
    title: "Want comparison before purchasing",
    summary:
      "On travel searches you prefer seeing options, sources and tradeoffs before login, payment or booking.",
    domain: "personal",
    cadence: "When trips or bookings arise",
    confidence: 0.78,
    status: "candidate",
    evidence: [
      "2 browser tasks stopped the flow before sensitive actions",
      "Approval policies blocked payment and personal data sending",
      "Memory contains only route, date and comparison preference",
    ],
  },
  {
    id: "local_first_defaults",
    title: "Strong local-first preference",
    summary:
      "Cloud and managed providers stay disabled until you grant an explicit opt-in for the specific domain.",
    domain: "privacy",
    cadence: "Always",
    confidence: 0.92,
    status: "confirmed",
    evidence: [
      "Local inference provider selected as default",
      "Managed cloud marked as disabled in settings",
      "Write actions require user confirmation",
    ],
  },
];

export const automationProposals: AutomationProposal[] = [
  {
    id: "daily_project_briefing",
    title: "Morning project briefing",
    summary:
      "Prepare a local summary of git, open tasks, recent notes and blockers every morning.",
    trigger: "Weekdays at 08:45 or when you open the project",
    actions: [
      "Reads local repository and tasks",
      "Recalls redacted work memory",
      "Proposes the next action without sending anything",
    ],
    autonomyLevel: 2,
    risk: "low",
    status: "ready",
  },
  {
    id: "travel_watchlist",
    title: "Travel deals monitor",
    summary:
      "Watch a route and alert you when price, time or availability change meaningfully.",
    trigger: "When you save a route with a future date",
    actions: [
      "Opens the local browser in background",
      "Compares results with previous snapshots",
      "Asks approval before login or purchase",
    ],
    autonomyLevel: 3,
    risk: "medium",
    status: "needs_approval",
  },
  {
    id: "memory_candidate_review",
    title: "Weekly habit review",
    summary:
      "Show what the system thinks it learned and let you confirm, correct or delete.",
    trigger: "Every Friday afternoon",
    actions: [
      "Groups candidate insights by privacy domain",
      "Highlights redacted evidence and confidence level",
      "Applies only confirmed corrections",
    ],
    autonomyLevel: 1,
    risk: "low",
    status: "ready",
  },
];

export const connections: ConnectionItem[] = [
  {
    id: "browser",
    name: "My browser",
    type: "native",
    status: "connected",
    description: "Local actions with Playwright/CDP and approval gates.",
  },
  {
    id: "github",
    name: "GitHub MCP",
    type: "mcp",
    status: "available",
    description: "Repositories, issues and pull requests via local MCP.",
  },
  {
    id: "calendar",
    name: "Calendario",
    type: "managed",
    status: "disabled",
    description: "Optional managed provider, requires cloud opt-in.",
  },
  {
    id: "wiki",
    name: "Obsidian Wiki",
    type: "skill",
    status: "connected",
    description: "Readable and correctable memory in Markdown.",
  },
  {
    id: "gmail",
    name: "Gmail",
    type: "managed",
    status: "disabled",
    description: "Email reading and drafts via opt-in provider.",
  },
  {
    id: "drive",
    name: "Google Drive",
    type: "managed",
    status: "disabled",
    description: "Cloud files only with explicit privacy boundaries.",
  },
  {
    id: "calendar-local",
    name: "Local calendar",
    type: "native",
    status: "available",
    description: "On-device events and availability.",
  },
  {
    id: "browser-skill",
    name: "browser-booking",
    type: "skill",
    status: "available",
    description: "Reusable workflow for forms and bookings.",
  },
  {
    id: "memory-skill",
    name: "memory-briefing",
    type: "skill",
    status: "connected",
    description: "Local synthesis from memory and wiki.",
  },
];

export const settingsSections: Array<{
  id: SettingsSectionId;
  label: string;
  icon: typeof Monitor;
  group: "account" | "capabilities";
}> = [
  { id: "account", label: "settings.account", icon: User, group: "account" },
  { id: "general", label: "settings.general", icon: SlidersHorizontal, group: "account" },
  { id: "appearance", label: "settings.appearance", icon: Palette, group: "account" },
  { id: "runtime", label: "settings.runtime", icon: Cpu, group: "account" },
  { id: "privacy", label: "settings.privacy", icon: KeyRound, group: "account" },
  { id: "memory", label: "nav.memory", icon: Brain, group: "account" },
  { id: "contacts", label: "nav.contacts", icon: Users, group: "account" },
  { id: "channels", label: "settings.channels", icon: MessageSquare, group: "capabilities" },
  { id: "connections", label: "settings.connectors", icon: Plug, group: "capabilities" },
  { id: "skills", label: "settings.skills", icon: Sparkles, group: "capabilities" },
  { id: "addon", label: "settings.addon", icon: Blocks, group: "capabilities" },
  { id: "computer", label: "Local computer", icon: MonitorPlay, group: "capabilities" },
];

export const settingsGroupLabels: Record<"account" | "capabilities", string> = {
  account: "settings.account",
  capabilities: "settings.capabilities",
};

export const drawerTasks = [
  { id: "task_prompt_session", label: "Local prompt", active: true },
  { id: "task_acme_summary", label: "Acme operational summary", active: false },
  { id: "task_memory_index", label: "Project memory index", active: false },
];

export const drawerProjects = [
  "homun",
  "Acme workspace",
  "Travel search",
];
