import {
  StudioResultWorkspace,
  StudioRoutineProvider,
  StudioActivityHub,
  StudioRoutineList,
} from "./StudioRoutineActivity";
import { StudioMembersContext } from "../../lib/studio-members";
import { StudioAutonomy } from "./StudioAutonomy";
import { autonomyLabels } from "../../lib/studio-autonomy";
import { teamSupervision, type AutonomyMode } from "../../lib/studio-supervision";
import { StudioHomeChat, type ChatProjectRequest } from "./StudioHomeChat";
import { prepareDelegation, delegationRequests } from "../../lib/studio-delegation";
import { StudioMaterialContext } from "../../lib/studio-material-context";
import { StudioTraining, type TrainingActivity } from "./StudioTraining";
import { StudioProcedures } from "./StudioProcedures";
import { reconcileProcedureTasks } from "../../lib/studio-pipelines";
import { StudioSquad, type WorkTeam } from "./StudioSquad";
import { StudioConversation, type ConversationContext } from "./StudioConversation";
import type { ConversationMessage } from "../../lib/studio-conversations";
import { StudioHuman } from "./StudioHuman";
import { StudioDocuments, type SharedDocument } from "./StudioDocuments";
import { defaultRule } from "../../lib/studio-simulation";
import { StudioSettings } from "./StudioSettings";
import { StudioWorkForm } from "./StudioWorkForm";
import { StudioSchedule } from "./StudioSchedule";
import { workStates, statusOf, workDate } from "../../lib/studio-work";
import { StudioToday, type AssignedWork, type TodayProject, type OpsStage } from "./StudioToday";
import { useEffect, useState } from "react";
import { StudioAccess, BotAccess, initialSpaceUsers, type BotAccessPolicy } from "./StudioAccess";
import { StudioProjects } from "./StudioProjects";
import { StudioMarketplace } from "./StudioMarketplace";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  CircleHelp,
  Clock3,
  FileText,
  FolderOpen,
  Layers3,
  CalendarDays,
  Columns3,
  MessageCircle,
  MoreHorizontal,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  Puzzle,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
  X,
  Zap,
} from "lucide-react";
import "./studio-workbench.css";

type Person = {
  id: string;
  name: string;
  role: string;
  color: string;
  initials: string;
  responsibility: string;
  specializations?: string[];
  tools: string[];
  method: string;
  tone: string;
  budget: string;
  activities?: TrainingActivity[];
  autonomy?: AutonomyMode;
};
const initialPeople: Person[] = [
  {
    specializations: ["Analisi dei log", "Pianificazione dei task", "Controllo qualità"],
    id: "elio",
    name: "Elio",
    role: "Operazioni & qualità",
    color: "mint",
    initials: "E",
    responsibility:
      "Individua errori nei log, raccoglie il contesto dei task e prepara piani di lavoro motivati.",
    tools: ["Server · sola lettura", "Trello", "Mattermost", "Wiki"],
    method:
      "Raccogli errori e task aperti\nCollega discussioni e documentazione\nValuta impatto, urgenza e dipendenze\nPrepara un piano con le fonti\nChiedi una revisione prima di aggiornare Trello",
    tone: "Diretto e sintetico. Separa fatti, ipotesi e informazioni mancanti.",
    budget: "10",
  },
  {
    specializations: ["Ricerca", "Verifica delle fonti", "Sintesi"],
    id: "vera",
    name: "Vera",
    role: "Ricerca & aggiornamenti",
    color: "lilac",
    initials: "V",
    responsibility: "Segue le fonti selezionate e prepara aggiornamenti utili alla squadra.",
    tools: ["Ricerca web", "Wiki"],
    method:
      "Consulta le fonti\nControlla data e attendibilità\nPrepara una sintesi con i riferimenti",
    tone: "Chiaro e documentato, senza enfasi commerciale.",
    budget: "5",
  },
  {
    specializations: ["Relazioni con i clienti", "Preparazione risposte"],
    id: "marta",
    name: "Marta",
    role: "Ufficio & clienti",
    color: "peach",
    initials: "M",
    responsibility: "Prepara risposte e organizza le richieste dei clienti.",
    tools: ["Posta · da collegare", "Documenti"],
    method:
      "Leggi la richiesta\nVerifica le informazioni disponibili\nPrepara una bozza\nChiedi conferma prima di inviare",
    tone: "Professionale e cordiale. Dai del lei ai clienti.",
    budget: "5",
  },
];
const jobs = [
  {
    id: "import",
    person: "elio",
    tag: "Priorità alta",
    title: "Elio ha raggruppato gli errori dell’importazione.",
    summary:
      "Un errore nei log, un task già aperto e una discussione che aiuta a capire da dove partire.",
    sources: ["Log server", "Trello · OPS-42", "Mattermost", "Wiki"],
    evidence: [
      "Log di esempio: CONFIG_ERROR — REPORT_DIR non definita. 18 occorrenze nella finestra analizzata.",
      "Task fittizio OPS-42: importazione report bloccata dopo il rilascio.",
      "Discussione dimostrativa: verificare le variabili dell’ambiente di esecuzione.",
      "Wiki di esempio: REPORT_DIR deve indicare una cartella scrivibile.",
    ],
    plan: [
      "Confrontare la configurazione del servizio con quella documentata.",
      "Riprodurre l’errore in un ambiente di prova.",
      "Correggere la configurazione e verificare la scrittura dei report.",
      "Preparare rilascio e controllo successivo dei log.",
    ],
    reason:
      "Il problema blocca l’importazione e ha un task aperto. Il collegamento con la configurazione è un’ipotesi da verificare.",
  },
  {
    id: "backlog",
    person: "elio",
    tag: "Da decidere",
    title: "Elio propone la priorità di tre task.",
    summary: "Il contesto è raccolto. Manca una decisione sull’ordine del lavoro.",
    sources: ["Trello", "Mattermost"],
    evidence: [
      "Esempio: un task blocca la consegna, uno riduce errori ricorrenti, uno è un miglioramento.",
      "Mancano stime affidabili: l’ordine è una proposta, non una pianificazione confermata.",
    ],
    plan: [
      "Confermare la scadenza della consegna.",
      "Stimare il lavoro con il responsabile.",
      "Rivedere l’ordine proposto prima di aggiornare Trello.",
    ],
    reason: "Ordine suggerito per impatto e dipendenze. La stima del lavoro potrebbe cambiarlo.",
  },
  {
    id: "research",
    person: "vera",
    tag: "Da leggere",
    title: "Vera ha preparato una sintesi degli aggiornamenti.",
    summary: "Una sintesi di esempio con i punti da approfondire e le fonti da verificare.",
    sources: ["Ricerca web", "Wiki"],
    evidence: [
      "Contenuto illustrativo: nessuna ricerca web è stata eseguita.",
      "Nel prodotto ogni affermazione rimanderà alla fonte e alla data di consultazione.",
    ],
    plan: ["Verificare le fonti selezionate.", "Scegliere quali novità approfondire."],
    reason: "Da leggere dopo i problemi operativi, salvo nuove scadenze.",
  },
];
function Face({ person, small = false }: { person: Person; small?: boolean }) {
  return (
    <span aria-hidden="true" className={`st-face ${person.color} ${small ? "small" : ""}`}>
      <span className="st-eyes">
        <i />
        <i />
      </span>
      <span className="st-smile" />
    </span>
  );
}
export function StudioWorkbench() {
  const [emptyStart] = useState(() => new URLSearchParams(location.search).get("empty") === "1");
  const [people, setPeople] = useState(emptyStart ? [] : initialPeople);
  const [procedureTarget, setProcedureTarget] = useState<{
    id: string;
    nonce: number;
    fromTask?: boolean;
  } | null>(null);
  const [opsStage, setOpsStage] = useState<OpsStage>("waiting");
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [projectSummaries, setProjectSummaries] = useState<TodayProject[]>([]);
  const [projectTarget, setProjectTarget] = useState<{ id: string; nonce: number } | null>(null);
  const [assignedWork, setAssignedWork] = useState<AssignedWork[]>(() => {
    if (emptyStart) return [];
    const d = new Date();
    d.setDate(d.getDate() + 2);
    const due =
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0") +
      "T15:00";
    return [
      {
        id: "context-demo",
        demoCost: 1,
        title: "Raccogliere il contesto dei task",
        person: "vera",
        project: "ops",
        status: "doing",
        due,
        steps: [
          { id: "context-sources", title: "Confrontare Trello, Mattermost e wiki", done: false },
          { id: "context-delivery", title: "Consegnare i riferimenti a Elio", done: false },
        ],
      },
      {
        id: "import",
        demoCost: 2.8,
        title: "Preparare il piano di lavoro",
        person: "elio",
        project: "ops",
        status: "blocked",
        due,
        steps: [
          {
            id: "plan-context",
            title: "Ricevere il contesto",
            done: false,
            blocker: "bot:vera",
            reason: "Servono i riferimenti di Trello, Mattermost e wiki",
          },
          { id: "plan-draft", title: "Preparare il piano e le priorità", done: false },
        ],
      },
      {
        id: "backlog",
        demoCost: 0.4,
        title: "Confermare le priorità dei task",
        person: "elio",
        project: "ops",
        status: "review",
        steps: [{ id: "priority-order", title: "Proporre l’ordine dei task", done: true }],
        result:
          "Proposta dimostrativa: 1. Ripristinare la cartella dei report. 2. Verificare la configurazione. 3. Aggiornare la documentazione. Nessuna modifica su Trello.",
      },
      {
        id: "research",
        demoCost: 0.4,
        title: "Sintesi degli aggiornamenti",
        person: "vera",
        project: "ops",
        status: "done",
        steps: [{ id: "research-summary", title: "Preparare la sintesi", done: true }],
        result:
          "Sintesi dimostrativa: la cartella dei report deve essere scrivibile e la configurazione REPORT_DIR va verificata. Fonti illustrative: wiki e discussione del servizio.",
      },
      {
        id: "quote-demo",
        demoCost: 0.8,
        rule: {
          ...defaultRule,
          trigger: "event",
          source: "Listino aggiornato caricato",
          needsFile: true,
        },
        title: "Preventivo Rossi · esempio",
        person: "marta",
        project: "",
        due,
        status: "blocked",
        steps: [
          {
            id: "quote-list",
            title: "Ricevere il listino aggiornato",
            done: false,
            blocker: "user:giulia",
            reason: "Serve il listino valido per il cliente Rossi",
          },
          { id: "quote-draft", title: "Preparare il preventivo", done: false },
          { id: "quote-check", title: "Verificare importi e condizioni", done: false },
        ],
      },
    ];
  });
  const [workTarget, setWorkTarget] = useState("");
  const [chatAssignment, setChatAssignment] = useState<{
    person: string;
    title: string;
    message?: ConversationMessage;
  } | null>(null);
  function openTask(id: string) {
    setWorkTarget(id);
    setJobId(null);
  }

  function openProject(id: string) {
    setWorkTarget("");
    setProjectTarget({ id, nonce: Date.now() });
    setView("projects");
    setJobId(null);
  }
  function openWork(id: string) {
    if (assignedWork.some((t) => t.id === id)) {
      openTask(id);
      return;
    }
    setJobId(id);
  }
  const [teams, setTeams] = useState<WorkTeam[]>([]);
  const [squadFilter, setSquadFilter] = useState("all");
  const [squadQuery, setSquadQuery] = useState("");
  const [spaceUsers, setSpaceUsers] = useState(
    emptyStart ? initialSpaceUsers.filter((u) => u.role === "owner") : initialSpaceUsers,
  );
  const [humanId, setHumanId] = useState("user:giulia");
  const [conversationMessages, setConversationMessages] = useState<
    Record<string, ConversationMessage[]>
  >({});
  const [conversationContext, setConversationContext] = useState<ConversationContext | null>(null);
  const [documents, setDocuments] = useState<SharedDocument[]>([]);
  function updateDocuments(next: SharedDocument[]) {
    const changed = next.filter((d) =>
      documents.some((old) => old.id === d.id && old.version !== d.version),
    );
    if (changed.length)
      setAssignedWork((all) =>
        reconcileProcedureTasks(
          all.map((t) =>
            changed.some((d) => d.taskIds.includes(t.id)) &&
            ["done", "review"].includes(t.status || "")
              ? {
                  ...t,
                  status: "doing",
                  notes: [
                    ...(t.notes || []),
                    "Documento condiviso aggiornato: serve una nuova verifica.",
                  ],
                }
              : t,
          ),
        ),
      );
    setDocuments(next);
  }
  const members = [
    ...people,
    ...spaceUsers
      .filter((u) => u.status === "active")
      .map((u) => ({
        ...people[0]!,
        id: "user:" + u.id,
        name: u.name,
        role: "Persona",
        responsibility: "Collabora a incarichi e documenti",
        specializations: [],
        method: "",
        tone: "",
        activities: [],
        autonomy: "stage" as const,
        budget: "",
        tools: [],
        color: "sage",
        initials: u.name.slice(0, 1),
      })),
  ];
  function shareMessage(message: ConversationMessage, taskId: string, personId: string) {
    setAssignedWork((all) =>
      all.map((t) =>
        t.id === taskId
          ? {
              ...t,
              messages: [
                ...(t.messages || []),
                {
                  ...message,
                  id: crypto.randomUUID(),
                  taskIds: [t.id],
                  projectIds: t.project ? [t.project] : [],
                  source: { person: personId, messageId: message.id },
                },
              ],
            }
          : t,
      ),
    );
  }
  function chooseMember(id: string, taskId?: string) {
    setWorkTarget("");
    setConversationContext(taskId ? { person: id, taskId, nonce: Date.now() } : null);
    if (id.startsWith("user:")) {
      setHumanId(id);
      setView("human");
      setJobId(null);
      if (window.innerWidth < 760) setSidebarOpen(false);
    } else select(id);
  }
  function remind(task: AssignedWork, step: NonNullable<AssignedWork["steps"]>[number]) {
    if (!step.blocker) return;
    const target = step.blocker.startsWith("bot:") ? step.blocker.slice(4) : step.blocker;
    if (!members.some((m) => m.id === target)) {
      setNotice("Il destinatario non è attivo nello spazio.");
      return;
    }
    const requestFor = task.id + ":" + step.id;
    const existing = assignedWork.find((t) => t.requestFor === requestFor);
    if (existing) {
      setAssignedWork((all) =>
        all.map((t) =>
          t.id === existing.id
            ? {
                ...t,
                notes: [
                  ...(t.notes || []),
                  "Fabio · sollecito locale " + new Date().toLocaleTimeString("it-IT"),
                ],
              }
            : t,
        ),
      );
      setNotice("Sollecito aggiunto alla richiesta esistente · demo, nessun invio.");
    } else {
      addAssignedWork([
        {
          id: crypto.randomUUID(),
          title: step.reason || step.title,
          person: target,
          project: projectSummaries.find((p) => p.id === task.project)?.members.includes(target)
            ? task.project
            : "",
          status: "todo",
          requestFor,
          due: task.due || "",
          participants: [task.person],
          approver: "user:fabio",
          notes: ["Fabio · richiesta collegata a: " + task.title],
        },
      ]);
      setNotice("Richiesta aggiunta agli incarichi del destinatario · demo, nessun invio.");
    }
  }

  const [botPolicies, setBotPolicies] = useState<Record<string, BotAccessPolicy>>({});
  function addAssignedWork(items: AssignedWork[]) {
    const expanded = items.flatMap((t) => [t, ...delegationRequests(t)]);
    const prepared = expanded.map((t) => {
      const policy = teamSupervision(
        t.person,
        teams,
        members,
        "user:" + (botPolicies[t.person]?.approver || "fabio"),
      );
      const member = people.find((p) => p.id === t.person);
      return prepareDelegation(
        {
          ...t,
          ...(!t.person.startsWith("user:")
            ? {
                supervisor: policy.supervisor,
                training: t.training || {
                  activity: "Nuovo incarico",
                  scope: "Entro i permessi e il budget assegnati",
                  mode: member?.autonomy || "stage",
                },
              }
            : {}),
        },
        policy.approver,
      );
    });
    setAssignedWork((all) => [...all, ...prepared]);
  }

  const [view, setView] = useState("today");
  const [homeMode, setHomeMode] = useState<"chat" | "dashboard">(() => {
    try {
      return localStorage.getItem("homun-home-mode") === "dashboard" ? "dashboard" : "chat";
    } catch {
      return "chat";
    }
  });
  const [dashboardView, setDashboardView] = useState("today");
  const [chatContext, setChatContext] = useState("");
  const [chatProjectRequest, setChatProjectRequest] = useState<ChatProjectRequest | null>(null);
  function switchHome(mode: "chat" | "dashboard") {
    setHomeMode(mode);
    setView(mode === "chat" ? "today" : dashboardView);
    setJobId(null);
    setWorkTarget("");
    try {
      localStorage.setItem("homun-home-mode", mode);
    } catch {
      /* UI preference is optional */
    }
  }
  function chatAboutTask(id: string) {
    setChatContext("task:" + id);
    switchHome("chat");
  }

  const [settingsMode, setSettingsMode] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState("space");
  const [settingsSearch, setSettingsSearch] = useState("");
  const [returnView, setReturnView] = useState("today");
  const [returnJob, setReturnJob] = useState<string | null>(null);
  const settingsCategories: [string, string][] = [
    ["space", "Generali"],
    ["models", "Modelli"],
    ["costs", "Costi e limiti"],
    ["notifications", "Notifiche"],
    ["data", "Dati e connessioni"],
    ["access", "Persone e accessi"],
  ];
  function openSettings(category = "space") {
    if (!settingsMode) {
      setReturnView(view);
      setReturnJob(jobId);
    }
    setSettingsMode(true);
    setSettingsCategory(category);
    setView(category === "access" ? "access" : "preferences");
    setJobId(null);
    document.getElementById("studio-profile-menu")?.hidePopover();
  }

  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    if (window.matchMedia("(max-width: 900px)").matches) setSidebarOpen(false);
  }, []);
  const [selected, setSelected] = useState("elio");
  const [jobId, setJobId] = useState<string | null>(null);
  const [tab, setTab] = useState("work");
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [need, setNeed] = useState("");
  const [notice, setNotice] = useState("");
  const person = people.find((p) => p.id === selected) || people[0]!;
  const job = jobs.find((j) => j.id === jobId);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view, selected, jobId]);
  useEffect(() => {
    if (!newOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      document
        .querySelector<HTMLButtonElement>('[aria-label="Aggiungi collaboratore dalla testata"]')
        ?.focus({ preventScroll: true });
    };
  }, [newOpen]);
  function select(id: string) {
    setSelected(id);
    setView("person");
    setTab("chat");
    setJobId(null);
    setNotice("");
  }
  function patch(field: keyof Person, value: string) {
    setPeople((ps) => ps.map((p) => (p.id === selected ? { ...p, [field]: value } : p)));
  }
  function add() {
    if (!newName.trim() || !need.trim()) return;
    const id = `local-${Date.now()}`;
    setPeople((ps) => [
      ...ps,
      {
        id,
        name: newName.trim(),
        role: "Nuovo incarico",
        color: "mint",
        initials: newName[0] || "N",
        responsibility: need.trim(),
        tools: [],
        method: "",
        tone: "Professionale e cordiale",
        budget: "0",
      },
    ]);
    setNewOpen(false);
    setNewName("");
    setNeed("");
    select(id);
    setTab("settings");
  }
  const workBoard = (
    <StudioSchedule
      onRepeat={(id) => {
        setProcedureTarget({ id, nonce: Date.now(), fromTask: true });
        setWorkTarget("");
        setView("automations");
        setJobId(null);
      }}
      onProcedure={(id) => {
        setProcedureTarget({ id, nonce: Date.now() });
        setWorkTarget("");
        setView("automations");
        setJobId(null);
      }}
      onProject={openProject}
      onCloseTask={() => setWorkTarget("")}
      overlayOnly={view !== "calendar" && view !== "kanban"}
      key={view}
      mode={view === "calendar" ? "calendar" : "kanban"}
      documents={documents}
      onUpdateDocuments={updateDocuments}
      onDocuments={() => {
        setWorkTarget("");
        setView("documents");
        setJobId(null);
      }}
      onShareResult={(t) => {
        const existing = documents.find((d) => d.taskIds.includes(t.id) && d.title === t.title);
        if (existing && existing.body === (t.result || "")) {
          setNotice("Il risultato è già disponibile nei Documenti condivisi.");
          return;
        }
        updateDocuments(
          existing
            ? documents.map((d) =>
                d.id === existing.id
                  ? {
                      ...d,
                      body: t.result || "",
                      version: d.version + 1,
                      history: [...d.history, "Nuova versione condivisa da Fabio"],
                    }
                  : d,
              )
            : [
                ...documents,
                {
                  id: crypto.randomUUID(),
                  title: t.title,
                  kind: "note",
                  projectId: t.project,
                  parentId: null,
                  ...(!t.project ? { accessIds: [t.person] } : {}),
                  author: members.find((m) => m.id === t.person)?.name || "Collaboratore",
                  body: t.result || "",
                  version: 1,
                  taskIds: [t.id],
                  history: ["Risultato della demo condiviso da Fabio"],
                },
              ],
        );
        setNotice("Risultato disponibile nei Documenti condivisi · demo.");
      }}
      onWorkspaceChat={chatAboutTask}
      onUpdateTasks={setAssignedWork}
      onOpenTask={openTask}
      onRemind={remind}
      target={workTarget}
      people={members}
      users={spaceUsers}
      projects={projectSummaries}
      tasks={assignedWork}
      onPerson={chooseMember}
      onSave={(t) => addAssignedWork([t])}
      onChange={(t) =>
        setAssignedWork((all) =>
          reconcileProcedureTasks(all.map((old) => (old.id === t.id ? t : old))),
        )
      }
    />
  );
  return (
    <StudioRoutineProvider>
      <StudioMembersContext.Provider value={members}>
        <StudioMaterialContext.Provider
          value={{ documents, projects: projectSummaries, members: members.map((m) => m.id) }}
        >
          <div id="homun-studio" className={sidebarOpen ? "st-sidebar-open" : "st-sidebar-closed"}>
            {sidebarOpen && (
              <button
                className="st-sidebar-backdrop"
                aria-label="Chiudi menu laterale"
                onClick={() => setSidebarOpen(false)}
              />
            )}
            {sidebarOpen && (
              <aside
                id="studio-sidebar"
                className="st-team"
                aria-label="Menu principale"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    if (document.getElementById("studio-profile-menu")?.matches(":popover-open"))
                      return;
                    setSidebarOpen(false);
                    requestAnimationFrame(() =>
                      document.getElementById("studio-menu-toggle")?.focus(),
                    );
                  }
                }}
              >
                <div className="st-sidebar-scroll">
                  {settingsMode ? (
                    <>
                      <button
                        className="st-settings-back"
                        onClick={() => {
                          setSettingsMode(false);
                          setView(returnView);
                          setJobId(returnJob);
                        }}
                      >
                        <ArrowDownLeft size={17} /> Torna allo spazio
                      </button>
                      <h2 className="st-settings-nav-title">Impostazioni</h2>
                      <input
                        aria-label="Cerca nelle impostazioni"
                        placeholder="Cerca nelle impostazioni…"
                        value={settingsSearch}
                        onChange={(e) => setSettingsSearch(e.target.value)}
                      />
                      <nav className="st-settings-navigation" aria-label="Categorie impostazioni">
                        {settingsCategories
                          .filter(([, label]) =>
                            label.toLowerCase().includes(settingsSearch.toLowerCase()),
                          )
                          .map(([id, label]) => (
                            <button
                              key={id}
                              className={settingsCategory === id ? "active" : ""}
                              aria-current={settingsCategory === id ? "page" : undefined}
                              onClick={() => openSettings(id)}
                            >
                              {id === "access" ? (
                                <ShieldCheck size={17} />
                              ) : id === "models" ? (
                                <Sparkles size={17} />
                              ) : (
                                <Settings2 size={17} />
                              )}{" "}
                              {label}
                            </button>
                          ))}
                        {!settingsCategories.some(([, label]) =>
                          label.toLowerCase().includes(settingsSearch.toLowerCase()),
                        ) && <p className="st-muted">Nessuna categoria trovata.</p>}
                      </nav>
                    </>
                  ) : (
                    <>
                      <div className="st-workspace">
                        <span className="st-workspace-icon">F</span>
                        <div>
                          <strong>Il tuo spazio</strong>
                          <small>Azienda demo</small>
                        </div>
                        <button
                          className="st-icon"
                          aria-label="Chiudi barra laterale"
                          onClick={() => {
                            setSidebarOpen(false);
                            requestAnimationFrame(() =>
                              document.getElementById("studio-menu-toggle")?.focus(),
                            );
                          }}
                        >
                          <PanelLeftClose size={18} />
                        </button>
                      </div>
                      <div className="st-sidebar-home">
                        <button
                          className={["today", "calendar", "kanban"].includes(view) ? "active" : ""}
                          onClick={() => {
                            setView(homeMode === "chat" ? "today" : dashboardView);
                            setJobId(null);
                          }}
                        >
                          <Layers3 size={17} /> Home
                        </button>
                        <div className="st-sidebar-team-link">
                          <button
                            className={view === "team" ? "active" : ""}
                            onClick={() => {
                              setView("team");
                              setJobId(null);
                            }}
                          >
                            <Users size={17} /> Tutti i collaboratori
                          </button>
                          <button
                            className="st-sidebar-add-member"
                            aria-label="Aggiungi collaboratore"
                            title="Aggiungi collaboratore"
                            onClick={() => setNewOpen(true)}
                          >
                            <Plus size={16} />
                          </button>
                        </div>
                        <nav className="st-workspace-nav" aria-label="Strumenti dello spazio">
                          {[
                            { id: "automations", label: "Automazioni", icon: Zap },
                            { id: "documents", label: "Documenti", icon: FileText },
                            { id: "marketplace", label: "Plugin", icon: Puzzle },
                          ].map((item) => (
                            <button
                              key={item.id}
                              className={view === item.id ? "active" : ""}
                              aria-current={view === item.id ? "page" : undefined}
                              onClick={() => {
                                setView(item.id);
                                setJobId(null);
                                if (window.innerWidth < 760) setSidebarOpen(false);
                              }}
                            >
                              <item.icon size={17} />
                              {item.label}
                            </button>
                          ))}
                        </nav>
                      </div>
                      <StudioSquad
                        avatar={(id) => {
                          const agent = people.find((p) => p.id === id);
                          return agent ? <Face person={agent} small /> : null;
                        }}
                        compact
                        members={members}
                        projects={projectSummaries}
                        teams={teams}
                        onTeams={setTeams}
                        onAutonomy={(modes) =>
                          setPeople((ps) =>
                            ps.map((p) => (modes[p.id] ? { ...p, autonomy: modes[p.id]! } : p)),
                          )
                        }
                        onPerson={chooseMember}
                        onManage={() => {
                          setView("team");
                          setJobId(null);
                        }}
                        filter={squadFilter}
                        onFilter={setSquadFilter}
                        query={squadQuery}
                        onQuery={setSquadQuery}
                      />

                      <section className="st-squad compact st-sidebar-projects">
                        <div className="st-squad-heading">
                          <button
                            aria-expanded={!projectsCollapsed}
                            aria-controls="sidebar-project-list"
                            onClick={() => setProjectsCollapsed(!projectsCollapsed)}
                          >
                            {projectsCollapsed ? (
                              <ChevronRight size={14} />
                            ) : (
                              <ChevronDown size={14} />
                            )}
                            Progetti <small>{projectSummaries.length}</small>
                          </button>
                          <div className="st-squad-header-actions">
                            <button
                              className={`st-squad-filter-toggle ${projectSearch.trim() ? "has-filter" : ""}`}
                              aria-label="Mostra ricerca progetti"
                              aria-expanded={projectSearchOpen}
                              onClick={() => {
                                setProjectSearchOpen(!projectSearchOpen);
                                setProjectsCollapsed(false);
                              }}
                            >
                              <SlidersHorizontal size={16} />
                              {projectSearch.trim() && <span className="st-filter-dot" />}
                            </button>
                            <button
                              aria-label="Tutti i progetti"
                              title="Tutti i progetti"
                              onClick={() => openProject("all")}
                            >
                              <FolderOpen size={16} />
                            </button>
                            <button
                              aria-label="Crea progetto"
                              title="Crea progetto"
                              onClick={() => openProject("new")}
                            >
                              <Plus size={16} />
                            </button>
                          </div>
                        </div>
                        {!projectsCollapsed && (
                          <div id="sidebar-project-list">
                            {projectSearchOpen && (
                              <input
                                aria-label="Cerca progetti nella sidebar"
                                placeholder="Cerca un progetto…"
                                value={projectSearch}
                                onChange={(e) => setProjectSearch(e.target.value)}
                              />
                            )}
                            <div className="st-project-shortcuts">
                              {projectSummaries
                                .filter((p) =>
                                  p.name
                                    .toLocaleLowerCase()
                                    .includes(projectSearch.trim().toLocaleLowerCase()),
                                )
                                .map((p) => (
                                  <button
                                    key={p.id}
                                    className={
                                      view === "projects" && activeProject === p.id ? "active" : ""
                                    }
                                    aria-current={
                                      view === "projects" && activeProject === p.id
                                        ? "page"
                                        : undefined
                                    }
                                    onClick={() => openProject(p.id)}
                                  >
                                    <FolderOpen size={17} />
                                    <span>{p.name}</span>
                                  </button>
                                ))}
                              {!projectSummaries.length ? (
                                <p>Nessun progetto. Creane uno con +.</p>
                              ) : (
                                !projectSummaries.some((p) =>
                                  p.name
                                    .toLocaleLowerCase()
                                    .includes(projectSearch.trim().toLocaleLowerCase()),
                                ) && <p>Nessun progetto trovato.</p>
                              )}
                            </div>
                          </div>
                        )}
                      </section>
                    </>
                  )}
                </div>
                <div className="st-profile-footer">
                  <div id="studio-profile-menu" popover="auto" className="st-profile-menu">
                    <div className="st-profile-menu-heading">
                      <strong>Fabio</strong>
                      <small>Proprietario · Azienda demo</small>
                    </div>
                    <a
                      className="st-prototype-mode"
                      href={emptyStart ? "?" : "?empty=1"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {emptyStart ? "Apri gli esempi" : "Prova il primo avvio"} ↗
                    </a>
                    <button onClick={() => openSettings()}>
                      <Settings2 size={17} /> Impostazioni
                    </button>
                    <button onClick={() => openSettings("costs")}>
                      <Layers3 size={17} /> Costi e limiti
                    </button>
                    <button onClick={() => openSettings("access")}>
                      <Users size={17} /> Persone e accessi
                    </button>
                  </div>
                  <button
                    className="st-profile-trigger"
                    popoverTarget="studio-profile-menu"
                    aria-label="Menu utente Fabio"
                  >
                    <span className="st-profile-avatar">F</span>
                    <span>
                      <strong>Fabio</strong>
                      <small>Azienda demo</small>
                    </span>
                    <ChevronDown size={16} />
                  </button>
                </div>
              </aside>
            )}
            <main className="st-main">
              <header className="st-topbar">
                <div className="st-breadcrumb">
                  <button
                    id="studio-menu-toggle"
                    className="st-icon"
                    aria-label={sidebarOpen ? "Chiudi barra laterale" : "Apri barra laterale"}
                    aria-expanded={sidebarOpen}
                    aria-controls="studio-sidebar"
                    onClick={() => setSidebarOpen(!sidebarOpen)}
                  >
                    <PanelLeftOpen size={18} />
                  </button>
                  <span>
                    Il tuo spazio <span className="st-slash">/</span>{" "}
                    <b>
                      {job
                        ? "Revisione"
                        : view === "documents"
                          ? "Documenti"
                          : view === "human"
                            ? members.find((m) => m.id === humanId)?.name || "Persona"
                            : view === "today"
                              ? homeMode === "chat"
                                ? "Chat"
                                : "Oggi"
                              : view === "calendar"
                                ? "Calendario"
                                : view === "kanban"
                                  ? "Kanban"
                                  : view === "automations"
                                    ? "Automazioni"
                                    : view === "preferences"
                                      ? "Impostazioni"
                                      : view === "access"
                                        ? "Persone e accessi"
                                        : view === "marketplace"
                                          ? "Plugin / Marketplace"
                                          : view === "projects"
                                            ? "Progetti"
                                            : view === "team"
                                              ? "La squadra"
                                              : person.name}
                    </b>
                  </span>
                </div>
                <div>
                  {!job && ["today", "calendar", "kanban"].includes(view) && (
                    <nav className="st-primary-home-switch" aria-label="Modalità della home">
                      <button
                        aria-label="Chat"
                        title="Chat"
                        className={homeMode === "chat" ? "active" : ""}
                        aria-pressed={homeMode === "chat"}
                        onClick={() => switchHome("chat")}
                      >
                        <MessageCircle size={17} />
                      </button>
                      <button
                        aria-label="Dashboard"
                        title="Dashboard"
                        className={homeMode === "dashboard" ? "active" : ""}
                        aria-pressed={homeMode === "dashboard"}
                        onClick={() => switchHome("dashboard")}
                      >
                        <Layers3 size={17} />
                      </button>
                    </nav>
                  )}
                  <StudioActivityHub tasks={assignedWork} onTask={openTask} />
                  <span className="st-local">
                    <span /> Demo locale
                  </span>
                  <button
                    className="st-icon"
                    aria-label="Aggiungi collaboratore dalla testata"
                    onClick={() => setNewOpen(true)}
                  >
                    <Plus size={18} />
                  </button>
                </div>
              </header>
              {notice && (
                <div role="status" className="st-notice">
                  {notice}
                  <button aria-label="Chiudi avviso" onClick={() => setNotice("")}>
                    <X size={16} />
                  </button>
                </div>
              )}
              <div className="st-content">
                <StudioResultWorkspace viewKey={`${view}:${homeMode}`}>
                  {view === "today" && homeMode === "dashboard" && !job && (
                    <StudioRoutineList dashboard />
                  )}
                  <div hidden={view !== "automations" || !!job}>
                    <StudioProcedures
                      target={procedureTarget}
                      people={members}
                      projects={projectSummaries}
                      tasks={assignedWork}
                      onRun={(tasks) => addAssignedWork(tasks)}
                      onTask={openTask}
                    />
                  </div>
                  <div hidden={view !== "documents" || !!job}>
                    <StudioDocuments
                      projects={projectSummaries}
                      members={members}
                      documents={documents}
                      onChange={updateDocuments}
                      tasks={assignedWork}
                      onTask={openTask}
                    />
                  </div>

                  <div hidden={view !== "today" || homeMode !== "chat" || !!job}>
                    <StudioHomeChat
                      people={members}
                      projects={projectSummaries}
                      tasks={assignedWork}
                      context={chatContext}
                      onContext={setChatContext}
                      onTask={(task) => addAssignedWork([task])}
                      onOpenTask={openTask}
                      onOpenProject={openProject}
                      onOpenPerson={chooseMember}
                      onAgent={(name, responsibility) => {
                        const id = crypto.randomUUID();
                        setPeople((all) => [
                          ...all,
                          {
                            id,
                            name,
                            responsibility,
                            role: "Collaboratore",
                            color: "mint",
                            initials: name.slice(0, 1),
                            tools: [],
                            method: "",
                            tone: "Professionale e cordiale",
                            budget: "0",
                          },
                        ]);
                        return id;
                      }}
                      onProject={(name, goal, members) => {
                        const id = crypto.randomUUID();
                        setChatProjectRequest({ id, name, goal, members });
                        return id;
                      }}
                    />
                  </div>
                  {!job &&
                    homeMode === "dashboard" &&
                    ["today", "calendar", "kanban"].includes(view) && (
                      <nav className="st-home-switch" aria-label="Vista della home">
                        {[
                          { id: "today", label: "Oggi", icon: Layers3 },
                          { id: "calendar", label: "Calendario", icon: CalendarDays },
                          { id: "kanban", label: "Kanban", icon: Columns3 },
                        ].map(({ id, label, icon: Icon }) => (
                          <button
                            key={id}
                            aria-current={view === id ? "page" : undefined}
                            className={view === id ? "active" : ""}
                            onClick={() => {
                              setDashboardView(id);
                              setView(id);
                              setWorkTarget("");
                              setJobId(null);
                            }}
                          >
                            <Icon size={16} />
                            {label}
                          </button>
                        ))}
                      </nav>
                    )}
                  <div hidden={view !== "preferences" || !!job}>
                    <StudioSettings
                      tab={settingsCategory}
                      people={people}
                      onAccess={() => openSettings("access")}
                    />
                  </div>
                  <div hidden={view !== "access" || !!job}>
                    <StudioAccess users={spaceUsers} onChange={setSpaceUsers} />
                  </div>
                  <div hidden={view !== "marketplace" || !!job}>
                    <StudioMarketplace
                      emptyStart={emptyStart}
                      people={people}
                      onAssign={(id, tool, enabled) =>
                        setPeople((ps) =>
                          ps.map((p) =>
                            p.id === id
                              ? {
                                  ...p,
                                  tools: enabled
                                    ? [...new Set([...p.tools, tool])]
                                    : p.tools.filter((t) => t !== tool),
                                }
                              : p,
                          ),
                        )
                      }
                    />
                  </div>
                  <div hidden={view !== "projects" || !!job}>
                    <StudioProjects
                      createRequest={chatProjectRequest}
                      onWorkspaceChat={(id) => {
                        setChatContext("project:" + id);
                        switchHome("chat");
                      }}
                      documents={documents}
                      onDocuments={updateDocuments}
                      documentProjects={projectSummaries}
                      emptyStart={emptyStart}
                      people={members}
                      onPerson={chooseMember}
                      users={spaceUsers}
                      onSummaries={setProjectSummaries}
                      onAssign={(t) => addAssignedWork([t])}
                      target={projectTarget}
                      onActiveChange={setActiveProject}
                      opsStage={opsStage}
                      onOpsStage={setOpsStage}
                      opsApproved={reviewed.includes("import")}
                      onPlan={() => openWork("import")}
                      tasks={assignedWork}
                      onTask={openTask}
                    />
                  </div>
                  {job ? (
                    <>
                      <button className="st-back" onClick={() => setJobId(null)}>
                        ← Torna al lavoro
                      </button>
                      <div className="st-detail-title">
                        <span className="st-eyebrow">PROPOSTA · DATI DI ESEMPIO</span>
                        <h1>{job.title}</h1>
                        <p>{job.summary}</p>
                        <button
                          className="st-text-link"
                          onClick={() =>
                            job.person === "elio" ? openProject("ops") : select("vera")
                          }
                        >
                          {job.person === "elio" ? "Progetto · Qualità e backlog" : "Apri Vera"}
                          <ArrowRight size={14} />
                        </button>
                      </div>
                      <div className="st-review-grid">
                        <section className="st-paper">
                          <h2>
                            {job.id === "research"
                              ? "La sintesi da consultare"
                              : "La proposta da rivedere"}
                          </h2>
                          <div className="st-plan">
                            {job.plan.map((step, i) => (
                              <div key={step}>
                                <span>{String(i + 1).padStart(2, "0")}</span>
                                <p>{step}</p>
                              </div>
                            ))}
                          </div>
                          <div className="st-approval">
                            <ShieldCheck size={20} />
                            <p>
                              {job.id === "research"
                                ? "Documento illustrativo, consultabile senza approvazione."
                                : reviewed.includes(job.id)
                                  ? "Approvazione registrata. Nessuna esecuzione avviata."
                                  : "Confermi soltanto la proposta, non autorizzi un’esecuzione reale."}
                              <br />
                              <small>Nessuna modifica a Trello o ai sistemi.</small>
                            </p>
                            <button
                              className="st-btn dark"
                              onClick={() =>
                                setReviewed((r) => (r.includes(job.id) ? r : [...r, job.id]))
                              }
                            >
                              {reviewed.includes(job.id) ? (
                                <>
                                  <Check size={16} />{" "}
                                  {job.id === "research" ? "Letto" : "Approvato"}
                                </>
                              ) : job.id === "research" ? (
                                "Segna come letto"
                              ) : job.id === "import" ? (
                                "Approva il piano · demo"
                              ) : (
                                "Conferma priorità · demo"
                              )}
                            </button>
                          </div>
                        </section>
                        <aside className="st-context">
                          <h3>Perché questa priorità</h3>
                          <p>{job.reason}</p>
                          <h3>Le evidenze</h3>
                          {job.evidence.map((e, i) => (
                            <details key={e}>
                              <summary>
                                <FileText size={15} />
                                {job.sources[i] || `Fonte ${i + 1}`}
                                <Plus size={13} />
                              </summary>
                              <p>{e}</p>
                            </details>
                          ))}
                        </aside>
                      </div>
                    </>
                  ) : view === "human" ? (
                    <StudioHuman
                      key={humanId}
                      person={
                        members.find((m) => m.id === humanId) || {
                          id: humanId,
                          name: "Persona non disponibile",
                        }
                      }
                      tasks={assignedWork}
                      projects={projectSummaries}
                      members={members}
                      messages={conversationMessages[humanId] || []}
                      onMessage={(m) =>
                        setConversationMessages((all) => ({
                          ...all,
                          [humanId]: [...(all[humanId] || []), m],
                        }))
                      }
                      onShare={(m, id) => shareMessage(m, id, humanId)}
                      onTask={openTask}
                      onProject={openProject}
                      context={conversationContext}
                      onAssign={(t) => addAssignedWork([t])}
                    />
                  ) : view === "calendar" || view === "kanban" ? (
                    workBoard
                  ) : view === "today" ? (
                    homeMode === "chat" ? null : (
                      <StudioToday
                        onCreatePerson={() => setNewOpen(true)}
                        people={members}
                        projects={projectSummaries}
                        tasks={assignedWork}
                        stage={opsStage}
                        approved={reviewed}
                        onPerson={chooseMember}
                        onProject={openProject}
                        onJob={openWork}
                        onTask={openTask}
                        onAssignBatch={(items) => addAssignedWork(items)}
                        onAssign={(task) => addAssignedWork([task])}
                        onMarta={() => {
                          select("marta");
                          setTab("settings");
                          setNotice(
                            "La casella reale non è collegata. La configurazione di account e cartelle sarà gestita dal motore; qui puoi definire strumenti e accessi.",
                          );
                        }}
                      />
                    )
                  ) : view === "projects" ||
                    view === "marketplace" ||
                    view === "access" ||
                    view === "preferences" ||
                    view === "automations" ||
                    view === "documents" ? null : view === "team" ? (
                    <>
                      <span className="st-eyebrow">LA TUA SQUADRA</span>
                      <div className="st-squad-page-heading">
                        <h1>La squadra</h1>
                        <div className="st-squad-page-actions">
                          <button className="st-btn" onClick={() => setView("access")}>
                            Invita una persona
                          </button>
                          <button className="st-btn dark" onClick={() => setNewOpen(true)}>
                            <Plus size={16} /> Crea un agente
                          </button>
                        </div>
                      </div>
                      <p className="st-intro">
                        Persone e agenti, ciascuno con una responsabilità. Selezionane uno per
                        lavorare insieme.
                      </p>
                      <StudioSquad
                        avatar={(id) => {
                          const agent = people.find((p) => p.id === id);
                          return agent ? <Face person={agent} small /> : null;
                        }}
                        members={members}
                        projects={projectSummaries}
                        teams={teams}
                        onTeams={setTeams}
                        onAutonomy={(modes) =>
                          setPeople((ps) =>
                            ps.map((p) => (modes[p.id] ? { ...p, autonomy: modes[p.id]! } : p)),
                          )
                        }
                        onPerson={chooseMember}
                        onManage={() => {
                          setView("team");
                          setJobId(null);
                        }}
                        filter={squadFilter}
                        onFilter={setSquadFilter}
                        query={squadQuery}
                        onQuery={setSquadQuery}
                      />
                    </>
                  ) : view === "library" ? (
                    <>
                      <span className="st-eyebrow">MEMORIA DEL PROGETTO</span>
                      <h1>Il contesto che resta.</h1>
                      <p className="st-intro">
                        Uno spazio condiviso di riferimento. Documenti dimostrativi.
                      </p>
                      <div className="st-job-list">
                        {[
                          "Configurazione del servizio report",
                          "Decisioni e vincoli del progetto",
                          "Linee guida di comunicazione",
                        ].map((s, i) => (
                          <details className="st-library-item" key={s}>
                            <summary>
                              <FileText size={22} />
                              <strong>{s}</strong>
                              <Plus size={16} />
                            </summary>
                            <p>
                              {
                                [
                                  "Esempio: REPORT_DIR deve indicare una cartella scrivibile. Elio può usarlo per confrontare log e configurazione.",
                                  "Esempio: ogni aggiornamento ai task richiede una revisione. I bot devono citare le fonti delle priorità proposte.",
                                  "Esempio: comunicazione chiara, sintetica e documentata. I collaboratori possono avere un tono specifico.",
                                ][i]
                              }
                            </p>
                          </details>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="st-profile st-agent-profile">
                        <Face person={person} />
                        <div>
                          <span className="st-eyebrow">IL TUO COLLABORATORE</span>
                          <h1>
                            {person.name}
                            <span className="st-profile-role">{person.role}</span>
                          </h1>
                          <p>{person.responsibility}</p>
                        </div>
                        <StudioAutonomy
                          mode={person.autonomy || "stage"}
                          onChange={(mode) =>
                            setPeople((ps) =>
                              ps.map((p) => (p.id === person.id ? { ...p, autonomy: mode } : p)),
                            )
                          }
                        />
                      </div>
                      <div className="st-agent-navigation">
                        <div className="st-tabs">
                          {[
                            ["chat", "Chat"],
                            ["work", "Compiti"],
                            ["settings", "Profilo"],
                          ].map(([id, label]) => (
                            <button
                              key={id}
                              className={tab === id ? "active" : ""}
                              onClick={() => {
                                setTab(id!);
                                setNotice("");
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <button
                          className="st-btn dark"
                          onClick={() => {
                            setTab("chat");
                            setChatAssignment({ person: person.id, title: "" });
                          }}
                        >
                          <Plus size={16} /> Assegna un compito
                        </button>
                      </div>
                      {tab === "work" && (
                        <>
                          <div className="st-section-head">
                            <h2>Compiti di {person.name}</h2>
                            <span className="st-muted">Esempi, non esecuzioni reali</span>
                          </div>
                          <div className="st-job-list">
                            {assignedWork
                              .filter((j) => j.person === person.id)
                              .map((j) => (
                                <button
                                  className="st-job"
                                  key={j.id}
                                  onClick={() => openWork(j.id)}
                                >
                                  <FileText size={22} />
                                  <span className="st-job-copy">
                                    <strong>{j.title}</strong>
                                    <small>
                                      {workStates[statusOf(j)]} ·{" "}
                                      {autonomyLabels[j.training?.mode || "stage"]} ·{" "}
                                      {workDate(j.due)}
                                    </small>
                                  </span>
                                  <ArrowUpRight size={18} />
                                </button>
                              ))}
                          </div>
                          {!assignedWork.some((j) => j.person === person.id) && (
                            <div className="st-empty">
                              <Sparkles size={28} />
                              <h2>Il primo incarico parte da te.</h2>
                              <p>Definisci il metodo e gli strumenti necessari a {person.name}.</p>
                              <button className="st-btn dark" onClick={() => setTab("settings")}>
                                Prepara il collaboratore <ArrowRight size={15} />
                              </button>
                            </div>
                          )}
                        </>
                      )}
                      {tab === "method" && (
                        <section className="st-paper">
                          <span className="st-eyebrow">IL SUO MODO DI LAVORARE</span>
                          <h2>Un metodo chiaro. Migliorabile.</h2>
                          <div className="st-plan">
                            {person.method
                              .split("\n")
                              .filter(Boolean)
                              .map((s, i) => (
                                <div key={i}>
                                  <span>{String(i + 1).padStart(2, "0")}</span>
                                  <p>{s}</p>
                                </div>
                              ))}
                          </div>
                          <details className="st-editor">
                            <summary>
                              <Settings2 size={15} /> Modifica i passaggi
                            </summary>
                            <label>
                              Un passaggio per riga
                              <textarea
                                value={person.method}
                                onChange={(e) => patch("method", e.target.value)}
                              />
                            </label>
                            <p className="st-muted">
                              Modifiche locali alla demo, conservate fino al ricaricamento.
                            </p>
                          </details>
                          <div className="st-soft-note">
                            <ShieldCheck size={18} /> Le azioni esterne richiedono una tua
                            revisione.
                          </div>
                        </section>
                      )}
                      {tab === "chat" && (
                        <section className="st-paper st-chat">
                          {chatAssignment?.person === person.id && (
                            <StudioWorkForm
                              key={chatAssignment.title}
                              people={people}
                              projects={projectSummaries}
                              person={person.id}
                              initialTitle={chatAssignment.title}
                              initialFiles={chatAssignment.message?.files || []}
                              defaultProject={
                                chatAssignment.message?.projectIds.find((id) =>
                                  projectSummaries.some(
                                    (p) => p.id === id && p.members.includes(person.id),
                                  ),
                                ) || ""
                              }
                              onClose={() => setChatAssignment(null)}
                              onSave={(t) => {
                                addAssignedWork([
                                  {
                                    ...t,
                                    ...(chatAssignment.message
                                      ? {
                                          sourceMessage: {
                                            person: person.id,
                                            id: chatAssignment.message.id,
                                          },
                                        }
                                      : {}),
                                  },
                                ]);
                                setChatAssignment(null);
                                openTask(t.id);
                              }}
                            />
                          )}
                          <StudioConversation
                            compact
                            key={person.id}
                            person={person}
                            messages={conversationMessages[person.id] || []}
                            onMessage={(m) =>
                              setConversationMessages((all) => ({
                                ...all,
                                [person.id]: [...(all[person.id] || []), m],
                              }))
                            }
                            tasks={assignedWork}
                            projects={projectSummaries}
                            onTask={openTask}
                            onProject={openProject}
                            onAssign={(m) =>
                              setChatAssignment({
                                person: person.id,
                                title: m.text || "Lavoro sugli allegati",
                                message: m,
                              })
                            }
                            people={members}
                            onShare={(m, id) => shareMessage(m, id, person.id)}
                            context={conversationContext}
                          />
                        </section>
                      )}
                      {tab === "settings" && (
                        <div className="st-settings">
                          <StudioTraining
                            activities={person.activities || []}
                            onChange={(activities) =>
                              setPeople((ps) =>
                                ps.map((p) => (p.id === person.id ? { ...p, activities } : p)),
                              )
                            }
                          />
                          <BotAccess
                            name={person.name}
                            tools={person.tools}
                            users={spaceUsers}
                            policy={
                              botPolicies[person.id] || {
                                operators: [],
                                approver: "fabio",
                                actions: {},
                              }
                            }
                            onChange={(policy) =>
                              setBotPolicies((ps) => ({ ...ps, [person.id]: policy }))
                            }
                          />
                          <section className="st-paper">
                            <div className="st-section-head" style={{ marginTop: 0 }}>
                              <h2>Identità e responsabilità</h2>
                              <button className="st-text-link" onClick={() => setTab("method")}>
                                Apri il metodo <ArrowRight size={14} />
                              </button>
                            </div>
                            <label>
                              Nome
                              <input
                                value={person.name}
                                onChange={(e) => patch("name", e.target.value)}
                              />
                            </label>
                            <label>
                              Cosa deve ottenere
                              <textarea
                                value={person.responsibility}
                                onChange={(e) => patch("responsibility", e.target.value)}
                              />
                            </label>
                            <label>
                              Specializzazioni · una per riga
                              <textarea
                                value={(person.specializations || []).join("\n")}
                                onChange={(e) =>
                                  setPeople((ps) =>
                                    ps.map((p) =>
                                      p.id === selected
                                        ? {
                                            ...p,
                                            specializations: e.target.value
                                              .split("\n")
                                              .filter(Boolean),
                                          }
                                        : p,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label>
                              Tono di voce
                              <textarea
                                value={person.tone}
                                onChange={(e) => patch("tone", e.target.value)}
                              />
                            </label>
                          </section>
                          <section className="st-paper">
                            <h2>Strumenti e limiti</h2>
                            <div className="st-tools">
                              {person.tools.map((t) => (
                                <span key={t}>{t}</span>
                              ))}
                            </div>
                            <label>
                              Strumenti previsti · uno per riga
                              <textarea
                                value={person.tools.join("\n")}
                                onChange={(e) =>
                                  setPeople((ps) =>
                                    ps.map((p) =>
                                      p.id === selected
                                        ? {
                                            ...p,
                                            tools: e.target.value.split("\n").filter(Boolean),
                                          }
                                        : p,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label>
                              Budget remoto mensile · €
                              <input
                                type="number"
                                min="0"
                                value={person.budget}
                                onChange={(e) => {
                                  if (Number(e.target.value) >= 0) patch("budget", e.target.value);
                                }}
                              />
                            </label>
                            <p className="st-muted">
                              Configurazione proposta. Consumo reale: nessuno. Modelli e servizi
                              saranno collegati nel motore.
                            </p>
                            <div className="st-soft-note">
                              <Check size={16} /> Modifiche mantenute in questa pagina
                            </div>
                          </section>
                        </div>
                      )}
                    </>
                  )}
                </StudioResultWorkspace>
              </div>
              <footer className="st-footer">
                <span>
                  homun <b>studio</b>
                </span>
                <span>Prototipo interattivo · dati fittizi · nessuna azione esterna</span>
              </footer>
            </main>
            {view !== "calendar" && view !== "kanban" && workTarget && workBoard}
            {newOpen && (
              <div className="st-modal-backdrop" onClick={() => setNewOpen(false)}>
                <section
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="st-new-title"
                  className="st-modal"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setNewOpen(false);
                    if (e.key === "Tab") {
                      const controls =
                        e.currentTarget.querySelectorAll<HTMLElement>("button, input, textarea");
                      const first = controls[0];
                      const last = controls[controls.length - 1];
                      if (e.shiftKey && document.activeElement === first) {
                        e.preventDefault();
                        last?.focus();
                      }
                      if (!e.shiftKey && document.activeElement === last) {
                        e.preventDefault();
                        first?.focus();
                      }
                    }
                  }}
                >
                  <button
                    className="st-modal-close st-icon"
                    aria-label="Chiudi creazione"
                    onClick={() => setNewOpen(false)}
                  >
                    <X size={20} />
                  </button>
                  <span className="st-eyebrow">UN POSTO NELLA TUA SQUADRA</span>
                  <h2 id="st-new-title">
                    Chi ti darebbe
                    <br />
                    una mano?
                  </h2>
                  <p>
                    Parti da una responsabilità. Potrai definire il resto insieme al collaboratore.
                  </p>
                  <div className="st-presets">
                    {[
                      "Controllare errori e preparare il lavoro",
                      "Seguire ricerche e aggiornamenti",
                      "Gestire richieste dei clienti",
                    ].map((s) => (
                      <button key={s} onClick={() => setNeed(s)}>
                        {s}
                        <ArrowDownLeft size={14} />
                      </button>
                    ))}
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      add();
                    }}
                  >
                    <label>
                      Di cosa si occuperà?
                      <textarea
                        autoFocus
                        required
                        placeholder="Vorrei qualcuno che…"
                        value={need}
                        onChange={(e) => setNeed(e.target.value)}
                      />
                    </label>
                    <label>
                      Come lo chiamiamo?
                      <input
                        required
                        placeholder="Un nome per il collaboratore"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                      />
                    </label>
                    <button className="st-btn dark" type="submit">
                      Aggiungi alla squadra demo <Plus size={16} />
                    </button>
                  </form>
                  <small>
                    Creazione locale, senza agente generatore. La bozza si azzera al ricaricamento.
                  </small>
                </section>
              </div>
            )}
          </div>
        </StudioMaterialContext.Provider>
      </StudioMembersContext.Provider>
    </StudioRoutineProvider>
  );
}
