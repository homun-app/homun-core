import {
  Bot,
  Brain,
  CalendarClock,
  CheckCircle2,
  Database,
  GalleryVerticalEnd,
  Globe2,
  History,
  KeyRound,
  MessageSquare,
  Monitor,
  Plug,
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
  { id: "connections", label: "Plugin", icon: Plug },
  { id: "automations", label: "Pianificato", icon: CalendarClock },
  { id: "memory", label: "Libreria", icon: Database },
];

export const chatMessages: ChatMessage[] = [
  {
    id: "m1",
    role: "user",
    text: "Cerca un treno Napoli-Milano per il 10 giugno e dimmi quali opzioni hanno senso.",
    timestamp: "15:21",
  },
  {
    id: "m2",
    role: "assistant",
    text: "Mi muovo sul browser locale e tengo separati ricerca, verifica fonti e riepilogo. Se una pagina richiede login o pagamento mi fermo prima dell'azione.",
    timestamp: "15:21",
    metadata: "Browser locale, shell disponibile, nessuna API cloud",
  },
  {
    id: "m3",
    role: "system",
    text: "Runtime Gemma 4 pronto. Browser assistant profile attivo. Managed cloud disabilitato.",
    timestamp: "15:22",
  },
];

export const computerSession: ComputerSession = {
  id: "computer_train_search",
  title: "Computer locale",
  subtitle: "Ricerca treni con browser e verifica finale in shell",
  status: "running",
  activeSurface: "browser",
  elapsed: "1m 42s",
  progressCurrent: 2,
  progressTotal: 4,
  previewTitle: "trainline.it / trenitalia.com",
  previewDetail: "Pagina risultati aperta in profilo assistant. Nessun dato personale inserito.",
  terminalExcerpt: [
    "local-task % date '+%Y-%m-%d %H:%M %Z'",
    "2026-05-23 16:31 CEST",
    "local-task % printf 'validazione fonti completata'",
  ],
  surfaces: [
    {
      id: "browser",
      label: "Browser",
      status: "running",
      detail: "2 tab controllati, snapshot redatti",
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
      status: "done",
      detail: "1 screenshot, 1 nota locale",
    },
    {
      id: "logs",
      label: "Log",
      status: "running",
      detail: "Eventi task redatti",
    },
  ],
  timeline: [
    {
      id: "open",
      surface: "browser",
      title: "Aprire il browser locale",
      detail: "Profilo assistant isolato, dominio consentito",
      status: "done",
      timestamp: "15:21",
    },
    {
      id: "search",
      surface: "browser",
      title: "Cercare tratte Napoli-Milano",
      detail: "Compilazione form senza login e senza pagamento",
      status: "running",
      timestamp: "15:22",
    },
    {
      id: "verify",
      surface: "shell",
      title: "Verificare data e fonti",
      detail: "Controllo locale prima del riepilogo",
      status: "waiting",
      timestamp: "in coda",
    },
  ],
  artifacts: [
    {
      id: "shot_results",
      name: "risultati-treni-redatto.png",
      kind: "screenshot",
      detail: "Anteprima locale, nessun dato personale",
    },
    {
      id: "terminal_check",
      name: "terminal-excerpt",
      kind: "terminal",
      detail: "Output redatto della verifica locale",
    },
  ],
};

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
      "Runtime locale Gemma 4 selezionato come default",
      "Managed cloud marcato come disabilitato in health e settings",
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
}> = [
  { id: "general", label: "Generali", icon: Monitor },
  { id: "privacy", label: "Privacy e autonomia", icon: KeyRound },
  { id: "runtime", label: "Runtime locale", icon: Bot },
  { id: "connections", label: "Connettori", icon: Plug },
  { id: "audit", label: "Audit e dati", icon: History },
];

export const drawerTasks = [
  { id: "task_browser_quote", label: "Treni Napoli-Milano", active: true },
  { id: "task_acme_summary", label: "Riepilogo operativo Acme", active: false },
  { id: "task_memory_index", label: "Indice memoria progetto", active: false },
];

export const drawerProjects = [
  "local-first-personal-assistant",
  "Acme workspace",
  "Ricerca viaggi",
];
