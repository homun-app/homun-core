import {
  Bot,
  Brain,
  CalendarClock,
  CheckCircle2,
  Database,
  Globe2,
  KeyRound,
  ListTodo,
  MessageSquare,
  Monitor,
  Plug,
  Settings,
} from "lucide-react";
import type {
  ApprovalItem,
  BrainRunDetail,
  ChatMessage,
  ConnectionItem,
  MemorySummary,
  NavItem,
  RuntimeHealth,
  SettingsSectionId,
  TaskItem,
} from "../types";

export const navItems: NavItem[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "tasks", label: "Task", icon: ListTodo, badge: "3" },
  { id: "memory", label: "Memoria", icon: Database },
  { id: "connections", label: "Connessioni", icon: Plug },
  { id: "automations", label: "Automazioni", icon: CalendarClock },
  { id: "browser", label: "Browser", icon: Globe2 },
  { id: "brain", label: "Brain Audit", icon: Brain },
  { id: "settings", label: "Impostazioni", icon: Settings },
];

export const chatMessages: ChatMessage[] = [
  {
    id: "m1",
    role: "user",
    text: "Organizza la mattina di lavoro Acme: controlla task, messaggi e prepara un riepilogo operativo.",
    timestamp: "15:21",
  },
  {
    id: "m2",
    role: "assistant",
    text: "Posso farlo localmente. Ho preparato un piano con lettura task, memoria progetto e una bozza di riepilogo. Le azioni che inviano messaggi restano in approvazione.",
    timestamp: "15:21",
    metadata: "2 tool caricati, 1 task in attesa approvazione",
  },
  {
    id: "m3",
    role: "system",
    text: "Runtime Gemma 4 pronto. Browser assistant profile disponibile. Managed cloud disabilitato.",
    timestamp: "15:22",
  },
];

export const brainRun: BrainRunDetail = {
  requestId: "req_acme_morning",
  route: "mixed_workflow",
  status: "running",
  plannerRounds: 2,
  loadedTools: 5,
  memoryRefs: ["memory:user:workspace:acme", "memory:user:workspace:routine"],
  steps: [
    {
      id: "context",
      label: "Carica contesto memoria",
      status: "done",
      detail: "2 riferimenti redatti",
    },
    {
      id: "tasks",
      label: "Leggi task e messaggi",
      status: "running",
      detail: "Tool read-only immediato",
    },
    {
      id: "review",
      label: "ReviewAgent",
      status: "queued",
      detail: "Subagent task durevole",
    },
  ],
};

export const tasks: TaskItem[] = [
  {
    id: "task_browser_quote",
    title: "Cerca disponibilità treno Napoli-Milano",
    kind: "browser_automation",
    status: "running",
    priority: "high",
    resource: "browser_session",
    risk: "medium",
    updated: "1 min fa",
  },
  {
    id: "task_acme_summary",
    title: "Riepilogo operativo Acme",
    kind: "subagent.ReviewAgent",
    status: "waiting_user_approval",
    priority: "normal",
    resource: "llm_inference",
    risk: "medium",
    updated: "3 min fa",
    blockedReason: "Serve conferma prima di inviare il riepilogo nel canale team.",
  },
  {
    id: "task_memory_index",
    title: "Aggiorna indice memoria progetto",
    kind: "memory_indexing",
    status: "queued",
    priority: "background",
    resource: "memory_indexing",
    risk: "low",
    updated: "8 min fa",
  },
  {
    id: "task_gemma_health",
    title: "Health check runtime locale Gemma 4",
    kind: "process.health",
    status: "completed",
    priority: "low",
    resource: "background_maintenance",
    risk: "low",
    updated: "12 min fa",
  },
];

export const approvals: ApprovalItem[] = [
  {
    id: "approval_acme",
    title: "Inviare riepilogo ad Acme",
    reason: "Azione write_with_confirmation verso connettore di messaggistica.",
    risk: "medium",
    requestedBy: "ReviewAgent",
  },
];

export const runtimeHealth: RuntimeHealth[] = [
  { label: "Gemma 4 MLX", status: "ready", detail: "Pronto, 31 tok/s stimati" },
  { label: "Browser", status: "running", detail: "Profilo assistant attivo" },
  { label: "Task Runtime", status: "running", detail: "3 task in coda" },
  { label: "Managed Cloud", status: "attention", detail: "Disabilitato per policy" },
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

export const connections: ConnectionItem[] = [
  {
    id: "browser",
    name: "Il mio browser",
    type: "native",
    status: "connected",
    description: "Azioni locali con Playwright/CDP e approval gates.",
  },
  {
    id: "github",
    name: "GitHub MCP",
    type: "mcp",
    status: "available",
    description: "Repository, issue e pull request tramite MCP locale.",
  },
  {
    id: "calendar",
    name: "Calendario",
    type: "managed",
    status: "disabled",
    description: "Provider managed opzionale, richiede opt-in cloud.",
  },
  {
    id: "wiki",
    name: "Obsidian Wiki",
    type: "skill",
    status: "connected",
    description: "Memoria leggibile e correggibile in Markdown.",
  },
];

export const settingsSections: Array<{
  id: SettingsSectionId;
  label: string;
  icon: typeof Monitor;
}> = [
  { id: "general", label: "Generali", icon: Monitor },
  { id: "privacy", label: "Privacy e autonomia", icon: KeyRound },
  { id: "runtime", label: "Runtime locale", icon: Bot },
  { id: "connections", label: "Connettori", icon: Plug },
  { id: "audit", label: "Audit e dati", icon: CheckCircle2 },
];
