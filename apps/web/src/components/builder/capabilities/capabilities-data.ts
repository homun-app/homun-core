export type CapabilityTab = "skills" | "tools" | "connectors" | "plugins";

export type CapabilitySource =
  | "all"
  | "installed"
  | "builtin"
  | "optional"
  | "browse_sh"
  | "nvidia"
  | "clawhub"
  | "lobehub"
  | "github"
  | "anthropic"
  | "openai";

export type CapabilityCategory =
  | "all"
  | "ai_agents"
  | "productivity"
  | "software_dev"
  | "science"
  | "security"
  | "creative"
  | "other";

export type CapabilityItem = {
  id: string;
  name: string;
  tab: CapabilityTab;
  author: string;
  version: string;
  isBuiltIn: boolean;
  source: CapabilitySource;
  category: CapabilityCategory;
  description: string;
  tags: string[];
  commandShortcut?: string;
  enabled: boolean;
};

export const CAPABILITY_SOURCES: Array<{ id: CapabilitySource; label: string }> = [
  { id: "all", label: "Tutte le sorgenti" },
  { id: "installed", label: "Installati" },
  { id: "builtin", label: "Integrati (Built In)" },
  { id: "optional", label: "Opzionali" },
  { id: "github", label: "GitHub" },
  { id: "clawhub", label: "ClawHub" },
  { id: "lobehub", label: "LobeHub" },
  { id: "browse_sh", label: "browse.sh" },
  { id: "nvidia", label: "NVIDIA" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
];

export const CAPABILITY_CATEGORIES: Array<{ id: CapabilityCategory; label: string; count?: number }> = [
  { id: "all", label: "Tutte le categorie" },
  { id: "ai_agents", label: "Agenti AI", count: 1992 },
  { id: "productivity", label: "Produttività", count: 1365 },
  { id: "software_dev", label: "Sviluppo Software", count: 657 },
  { id: "science", label: "Scienza & Ricerca", count: 514 },
  { id: "security", label: "Sicurezza", count: 507 },
  { id: "creative", label: "Creatività & Media", count: 482 },
  { id: "other", label: "Altro", count: 91632 },
];

export const INITIAL_CAPABILITIES: CapabilityItem[] = [
  {
    id: "apple-notes",
    name: "apple-notes",
    tab: "skills",
    author: "Hermes Agent",
    version: "v1.0.1",
    isBuiltIn: true,
    source: "builtin",
    category: "productivity",
    description: "Gestione di Apple Notes tramite la CLI memo: creazione, ricerca, visualizzazione e modifica note.",
    tags: ["Apple", "macOS", "Notes", "note-taking"],
    commandShortcut: "/memo",
    enabled: true,
  },
  {
    id: "apple-reminders",
    name: "apple-reminders",
    tab: "skills",
    author: "Hermes Agent",
    version: "v1.0.0",
    isBuiltIn: true,
    source: "builtin",
    category: "productivity",
    description: "Gestione di Apple Reminders tramite remindctl: aggiunta promemoria, elenchi e completamento attività.",
    tags: ["Apple", "macOS", "Reminders", "tasks", "todo"],
    commandShortcut: "/remindctl",
    enabled: true,
  },
  {
    id: "findmy",
    name: "findmy",
    tab: "skills",
    author: "Hermes Agent",
    version: "v1.0.0",
    isBuiltIn: true,
    source: "builtin",
    category: "other",
    description: "Localizzazione dispositivi Apple e AirTag tramite l'applicazione Dov'è (FindMy.app) su macOS.",
    tags: ["Apple", "macOS", "FindMy", "AirTag", "location", "tracking"],
    enabled: true,
  },
  {
    id: "claude-code",
    name: "claude-code",
    tab: "skills",
    author: "Hermes Agent + Teknum",
    version: "v2.2.1",
    isBuiltIn: true,
    source: "builtin",
    category: "software_dev",
    description: "Delega attività di programmazione a Claude Code CLI (implementazione feature, fix e revisione PR).",
    tags: ["AI Agents", "Linux", "macOS", "Windows", "Coding-Agent", "Claude", "Anthropic", "Code-Review", "Refactoring"],
    commandShortcut: "/claude",
    enabled: true,
  },
  {
    id: "codex",
    name: "codex",
    tab: "skills",
    author: "Hermes Agent",
    version: "v1.0.1",
    isBuiltIn: true,
    source: "builtin",
    category: "software_dev",
    description: "Delega attività di programmazione a OpenAI Codex CLI con supporto a test ed esecuzione.",
    tags: ["AI Agents", "Linux", "macOS", "Windows", "Coding-Agent", "Codex", "OpenAI", "Code-Review", "Refactoring"],
    commandShortcut: "/codex",
    enabled: true,
  },
  {
    id: "imessage",
    name: "imessage",
    tab: "skills",
    author: "Hermes Agent",
    version: "v1.0.0",
    isBuiltIn: true,
    source: "builtin",
    category: "productivity",
    description: "Invio e ricezione messaggi iMessage ed SMS tramite la CLI nativa imsg su macOS.",
    tags: ["Apple", "macOS", "iMessage", "SMS", "messaging"],
    commandShortcut: "/imsg",
    enabled: true,
  },
  {
    id: "hermes-agent",
    name: "hermes-agent",
    tab: "skills",
    author: "Hermes Agent + Teknum",
    version: "v3.2.0",
    isBuiltIn: true,
    source: "builtin",
    category: "ai_agents",
    description: "Configurazione, tematizzazione, estensione e orchestrazione avanzata multi-agente di Hermes.",
    tags: ["AI Agents", "Linux", "macOS", "Windows", "hermes", "setup", "configuration", "multi-agent", "spawning"],
    commandShortcut: "/hermes",
    enabled: true,
  },
  {
    id: "opencode",
    name: "opencode",
    tab: "skills",
    author: "Hermes Agent",
    version: "v1.2.0",
    isBuiltIn: true,
    source: "builtin",
    category: "software_dev",
    description: "Delega attività di programmazione autonoma a OpenCode CLI (analisi repository, feature e review).",
    tags: ["AI Agents", "Linux", "macOS", "Windows", "Coding-Agent", "OpenCode", "Autonomous", "Refactoring"],
    commandShortcut: "/opencode",
    enabled: true,
  },
  {
    id: "computer-use",
    name: "computer-use",
    tab: "tools",
    author: "Francesco Bonacci",
    version: "v2.1.0",
    isBuiltIn: true,
    source: "builtin",
    category: "ai_agents",
    description: "Controllo nativo del desktop in background (clic, digitazione, tasti speciali) con escalation su richiesta.",
    tags: ["AI Agents", "macOS", "Windows", "Linux", "computer-use", "desktop", "automation", "gui"],
    commandShortcut: "/desktop",
    enabled: true,
  },
  {
    id: "architecture-diagram",
    name: "architecture-diagram",
    tab: "tools",
    author: "Francesco Bonacci",
    version: "v1.4.0",
    isBuiltIn: true,
    source: "builtin",
    category: "productivity",
    description: "Generazione dinamica di diagrammi architetturali, flussi e sequenze tramite rendering Mermaid.",
    tags: ["Productivity", "Diagrams", "Mermaid", "Visualization", "Architecture"],
    commandShortcut: "/diagram",
    enabled: true,
  },
  {
    id: "web-search",
    name: "web-search",
    tab: "tools",
    author: "Homun Core",
    version: "v2.0.0",
    isBuiltIn: true,
    source: "builtin",
    category: "science",
    description: "Navigazione e ricerca web in tempo reale con protezione anti-SSRF su Chromium headless.",
    tags: ["Web", "Search", "Browser", "Research", "Scraping"],
    commandShortcut: "/web",
    enabled: true,
  },
  {
    id: "code-sandbox",
    name: "code-sandbox",
    tab: "tools",
    author: "Homun Core",
    version: "v1.5.0",
    isBuiltIn: true,
    source: "builtin",
    category: "software_dev",
    description: "Esecuzione isolata di codice Python / TypeScript per calcoli, elaborazione dati e script.",
    tags: ["Python", "Execution", "Sandbox", "IPC"],
    commandShortcut: "/run",
    enabled: true,
  },
  {
    id: "github-connector",
    name: "github-connector",
    tab: "connectors",
    author: "GitHub App",
    version: "v1.2.0",
    isBuiltIn: false,
    source: "github",
    category: "software_dev",
    description: "Sincronizzazione repository, lettura commit, gestione PR e trigger workflow di CI/CD.",
    tags: ["Git", "GitHub", "VCS", "PR", "Review"],
    enabled: true,
  },
  {
    id: "postgres-connector",
    name: "postgres-connector",
    tab: "connectors",
    author: "Homun Database",
    version: "v1.1.0",
    isBuiltIn: false,
    source: "builtin",
    category: "productivity",
    description: "Connessione diretta a database PostgreSQL: ispezione schemi, indici e generazione query.",
    tags: ["SQL", "Database", "PostgreSQL", "Analytics"],
    enabled: true,
  },
  {
    id: "memory-vault",
    name: "memory-vault",
    tab: "plugins",
    author: "Homun Core",
    version: "v2.0.0",
    isBuiltIn: true,
    source: "builtin",
    category: "security",
    description: "Archivio note e fatti di progetto con memoria vettoriale e salvataggio decisionale durevole.",
    tags: ["Memory", "Vault", "SQLite", "Vectors"],
    enabled: true,
  },
  {
    id: "git-checkpoints",
    name: "git-checkpoints",
    tab: "plugins",
    author: "Homun Core",
    version: "v1.3.0",
    isBuiltIn: true,
    source: "builtin",
    category: "security",
    description: "Snapshot Git Shadow trasparenti prima di ogni modifica ai file con rollback selettivo.",
    tags: ["Git", "Checkpoints", "Rollback", "Safety"],
    enabled: true,
  },
];
