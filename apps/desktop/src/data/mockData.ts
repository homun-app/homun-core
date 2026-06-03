import {
  Bot,
  Brain,
  CalendarClock,
  CheckCircle2,
  Cpu,
  Database,
  GalleryVerticalEnd,
  Globe2,
  History,
  KeyRound,
  MessageSquare,
  Monitor,
  MonitorPlay,
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

export const navItems: NavItem[] = [
  { id: "chat", label: "Nuovo compito", icon: MessageSquare },
  { id: "learning", label: "Apprendimento", icon: Brain },
  { id: "tasks", label: "Pianificato", icon: CalendarClock },
  { id: "memory", label: "Libreria", icon: Database },
];

export const chatMessages: ChatMessage[] = [
  {
    id: "m1",
    role: "assistant",
    text: "Sono pronto. Scrivimi pure.",
    timestamp: "ora",
    metadata: "Modello locale",
  },
];

export const computerSession: ComputerSession = {
  id: "computer_active_prompt",
  title: "Computer locale",
  subtitle: "Sessione locale pronta per prompt, shell e browser controllato",
  status: "running",
  activeSurface: "logs",
  elapsed: "0s",
  progressCurrent: 0,
  progressTotal: 3,
  previewTitle: "Sessione locale",
  previewDetail: "In attesa di prompt utente.",
  terminalExcerpt: [],
  surfaces: [
    {
      id: "browser",
      label: "Browser",
      status: "idle",
      detail: "Pronto per task browser controllati",
    },
    {
      id: "shell",
      label: "Terminale",
      status: "idle",
      detail: "Pronto per verifiche locali",
    },
    {
      id: "files",
      label: "File",
      status: "idle",
      detail: "Nessun artifact ancora",
    },
    {
      id: "logs",
      label: "Log",
      status: "running",
      detail: "Eventi prompt redatti",
    },
  ],
  timeline: [
    {
      id: "ready",
      surface: "logs",
      title: "Sessione locale pronta",
      detail: "In attesa di prompt utente",
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
    id: "task_prompt_session",
    title: "Prompt locale attivo",
    kind: "local_prompt",
    status: "running",
    priority: "high",
    resource: "shell_process",
    risk: "low",
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
    id: "task_provider_health",
    title: "Health check provider di inferenza",
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
    action: "connector.write_with_confirmation",
    boundary: "team_messaging",
    risk: "medium",
    requestedBy: "ReviewAgent",
  },
];

export const runtimeHealth: RuntimeHealth[] = [
  { label: "Modello", status: "ready", detail: "Provider di inferenza configurato" },
  { label: "Browser", status: "running", detail: "Profilo assistant attivo" },
  { label: "Task Runtime", status: "running", detail: "3 task in coda" },
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
    title: "Avvio spesso dal progetto attivo",
    summary:
      "Quando inizi una sessione di lavoro chiedi prima stato git, task aperti e prossima azione utile.",
    domain: "work",
    cadence: "Mattina, giorni feriali",
    confidence: 0.84,
    status: "confirmed",
    evidence: [
      "6 sessioni locali con apertura progetto e controllo task",
      "3 richieste consecutive hanno privilegiato stato, piano e verifica",
      "Nessun dato raw salvato: solo metadati e riferimenti redatti",
    ],
  },
  {
    id: "travel_compare_before_booking",
    title: "Vuoi confronto prima di acquistare",
    summary:
      "Sulle ricerche viaggio preferisci vedere opzioni, fonti e tradeoff prima di login, pagamento o prenotazione.",
    domain: "personal",
    cadence: "Quando emergono viaggi o prenotazioni",
    confidence: 0.78,
    status: "candidate",
    evidence: [
      "2 task browser hanno fermato il flusso prima di azioni sensibili",
      "Le approval policy hanno bloccato pagamento e invio dati personali",
      "La memoria contiene solo tratta, data e preferenza di confronto",
    ],
  },
  {
    id: "local_first_defaults",
    title: "Preferenza local-first forte",
    summary:
      "Cloud e provider gestiti restano disattivati finche' non concedi un opt-in esplicito per il singolo dominio.",
    domain: "privacy",
    cadence: "Sempre",
    confidence: 0.92,
    status: "confirmed",
    evidence: [
      "Provider di inferenza locale selezionato come default",
      "Managed cloud marcato come disabilitato in settings",
      "Le azioni write richiedono conferma utente",
    ],
  },
];

export const automationProposals: AutomationProposal[] = [
  {
    id: "daily_project_briefing",
    title: "Briefing mattutino progetto",
    summary:
      "Preparare ogni mattina un riepilogo locale di git, task aperti, note recenti e blocker.",
    trigger: "Giorni feriali alle 08:45 o quando apri il progetto",
    actions: [
      "Legge repository e task locali",
      "Richiama memoria lavoro redatta",
      "Propone la prossima azione senza inviare nulla",
    ],
    autonomyLevel: 2,
    risk: "low",
    status: "ready",
  },
  {
    id: "travel_watchlist",
    title: "Monitor offerte viaggio",
    summary:
      "Sorvegliare una tratta e avvisarti quando prezzo, orario o disponibilita' cambiano in modo rilevante.",
    trigger: "Quando salvi una tratta con data futura",
    actions: [
      "Apre il browser locale in background",
      "Confronta risultati con snapshot precedenti",
      "Chiede approvazione prima di login o acquisto",
    ],
    autonomyLevel: 3,
    risk: "medium",
    status: "needs_approval",
  },
  {
    id: "memory_candidate_review",
    title: "Review settimanale delle abitudini",
    summary:
      "Mostrare cosa il sistema pensa di aver imparato e permetterti di confermare, correggere o cancellare.",
    trigger: "Ogni venerdi' pomeriggio",
    actions: [
      "Raggruppa insight candidati per dominio privacy",
      "Evidenzia prove redatte e livello confidenza",
      "Applica solo le correzioni confermate",
    ],
    autonomyLevel: 1,
    risk: "low",
    status: "ready",
  },
];

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
  {
    id: "gmail",
    name: "Gmail",
    type: "managed",
    status: "disabled",
    description: "Lettura e bozze email tramite provider opt-in.",
  },
  {
    id: "drive",
    name: "Google Drive",
    type: "managed",
    status: "disabled",
    description: "File cloud solo con confini privacy espliciti.",
  },
  {
    id: "calendar-local",
    name: "Calendario locale",
    type: "native",
    status: "available",
    description: "Eventi e disponibilita' sul dispositivo.",
  },
  {
    id: "browser-skill",
    name: "browser-booking",
    type: "skill",
    status: "available",
    description: "Workflow riutilizzabile per form e prenotazioni.",
  },
  {
    id: "memory-skill",
    name: "memory-briefing",
    type: "skill",
    status: "connected",
    description: "Sintesi locale da memoria e wiki.",
  },
];

export const settingsSections: Array<{
  id: SettingsSectionId;
  label: string;
  icon: typeof Monitor;
  group: "account" | "capabilities";
}> = [
  { id: "account", label: "Account", icon: User, group: "account" },
  { id: "general", label: "Generale", icon: SlidersHorizontal, group: "account" },
  { id: "runtime", label: "Modello & Runtime", icon: Cpu, group: "account" },
  { id: "privacy", label: "Privacy & Autonomia", icon: KeyRound, group: "account" },
  { id: "memory", label: "Memoria", icon: Brain, group: "account" },
  { id: "contacts", label: "Contatti", icon: Users, group: "account" },
  { id: "channels", label: "Canali", icon: MessageSquare, group: "capabilities" },
  { id: "connections", label: "Connettori", icon: Plug, group: "capabilities" },
  { id: "skills", label: "Skill", icon: Sparkles, group: "capabilities" },
  { id: "computer", label: "Computer locale", icon: MonitorPlay, group: "capabilities" },
  { id: "audit", label: "Dati & Audit", icon: History, group: "capabilities" },
];

export const settingsGroupLabels: Record<"account" | "capabilities", string> = {
  account: "Account",
  capabilities: "Capacità",
};

export const drawerTasks = [
  { id: "task_prompt_session", label: "Prompt locale", active: true },
  { id: "task_acme_summary", label: "Riepilogo operativo Acme", active: false },
  { id: "task_memory_index", label: "Indice memoria progetto", active: false },
];

export const drawerProjects = [
  "local-first-personal-assistant",
  "Acme workspace",
  "Ricerca viaggi",
];
