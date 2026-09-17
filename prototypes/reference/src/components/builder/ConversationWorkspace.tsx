import { ConversationSelectField } from "./ConversationSelect";
import { ConversationSettings } from "./ConversationSettings";
import { defaultPreferences, type ConversationPreferences } from "./conversation-preferences";
import { readPrototype, savePrototype, resetPrototype } from "./conversation-storage";
import {
  busyWorks,
  busyProjects,
  busyRoutines,
  busyTeams,
  busyMaterials,
} from "./conversation-busy-demo";
import { ConversationCatalogPlan, type CatalogPlan } from "./ConversationCatalogPlan";
import { ConversationActions } from "./ConversationActions";
import { ConversationProjectNav } from "./ConversationProjectNav";
import { ConversationAvatar } from "./ConversationAvatar";
import { ConversationContribution } from "./ConversationContribution";
import { ConversationHumanWork } from "./ConversationHumanWork";
import { ConversationCreateMember } from "./ConversationCreateMember";
import { ConversationMaterials, type ConversationMaterial } from "./ConversationMaterials";
import { ConversationTasks } from "./ConversationTasks";
import { ConversationPlugins } from "./ConversationPlugins";
import { memberProfile, isHumanMember } from "./conversation-members";
import {
  ConversationSpace,
  type SpaceData,
  type SpaceView,
  type SpaceRoutine,
  spacePeople,
} from "./ConversationSpace";
import { ConversationSearch, type SearchEntry } from "./ConversationSearch";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  FileText,
  FolderOpen,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Sparkles,
  X,
  ArrowLeft,
  Clock3,
  Paperclip,
  Download,
  Play,
  Settings2,
} from "lucide-react";
import { StudioChatInput } from "./StudioChatInput";

type Phase = "proposal" | "waiting" | "ready" | "review" | "approved";
type Message = { sender?: string; who: "you" | "agent"; text: string };
export type Work = {
  archived?: boolean;
  catalogPlan?: CatalogPlan;
  coordinatedBy?: string;
  request?: { to: string; need: string; status: "pending" | "resolved"; childId?: string };
  routineId?: string;
  runNumber?: number;
  startedAt?: string;
  requester?: string;
  autonomy?: "supervised" | "autonomous";
  reviewer?: string;
  approvedBy?: string;
  autoDelivered?: boolean;
  humanDraft?: string;
  humanResult?: string;
  materialIds?: string[];
  projectId?: string;
  id: string;
  scenario: number;
  title: string;
  phase: Phase;
  due: string;
  messages: Message[];
  files: File[];
  contribution: string;
  revision: number;
  feedback: string;
};
const initialScenarios = [
  {
    title: "Il nuovo catalogo",
    agent: "Marta",
    initial: "Prepariamo il nuovo catalogo con @Marta, usando i listini aggiornati.",
    role: "Ufficio e clienti",
    color: "peach",
    icon: "M",
    input: "I listini aggiornati",
    help: "Carica i listini o indica dove trovarli. Aggiungi eventuali indicazioni su prodotti e prezzi da includere.",
    outcome: "Una prima bozza del catalogo da verificare insieme.",
    steps: [
      "Controllare prodotti, prezzi e informazioni mancanti",
      "Organizzare la prima bozza",
      "Consegnarti il catalogo per la verifica",
    ],
    result: "Bozza del catalogo",
    body: "# Catalogo · struttura proposta\n\n## Presentazione\nUna breve introduzione all’azienda e alla gamma di prodotti.\n\n## Prodotti\nPer ogni prodotto: nome, descrizione, variante, prezzo e disponibilità.\n\n## Condizioni commerciali\nValidità dei prezzi, tempi di consegna e contatti.\n\n## Da completare\nInserire prodotti e importi verificati dai listini. Questa è una struttura dimostrativa: i file caricati non sono stati analizzati.",
  },
  {
    title: "Uno sguardo al mercato",
    agent: "Vera",
    initial:
      "@Vera, prepara una ricerca sui concorrenti e sulle opportunità per la nostra azienda.",
    role: "Ricerca e aggiornamenti",
    color: "violet",
    icon: "V",
    input: "Il mercato e le aziende da confrontare",
    help: "Indica settore, paese e concorrenti. Puoi scrivere qui, aggiungere link o allegare un brief.",
    outcome: "Una ricerca con fonti, confronti e opportunità da valutare.",
    steps: [
      "Definire il perimetro della ricerca",
      "Confrontare le fonti e distinguere fatti da ipotesi",
      "Presentarti le opportunità con i riferimenti",
    ],
    result: "Ricerca di mercato",
    body: "# Ricerca · schema di confronto\n\n## Quadro del mercato\nSettore, area geografica e periodo di osservazione.\n\n## Confronto\nOfferta, posizionamento, prezzi pubblici e canali di vendita.\n\n## Opportunità da verificare\nBisogni poco coperti e ipotesi da testare.\n\n## Fonti\nDa raccogliere e verificare. Questa anteprima è dimostrativa: non è stata effettuata alcuna ricerca web.",
  },
  {
    title: "Capire gli errori",
    agent: "Elio",
    initial: "@Elio, analizza i log e proponi un piano per risolvere gli errori più urgenti.",
    role: "Operazioni e qualità",
    color: "sage",
    icon: "E",
    input: "I log e il servizio da controllare",
    help: "Allega i log o una cartella e indica servizio e intervallo da esaminare. Non inserire password o chiavi di accesso.",
    outcome: "Un riepilogo degli errori con priorità e piano di intervento.",
    steps: [
      "Raccogliere i log e delimitare il problema",
      "Distinguere sintomi, cause possibili e impatto",
      "Proporti gli interventi prima di modificare il sistema",
    ],
    result: "Piano di intervento",
    body: "# Analisi dei log · piano di verifica\n\n## Perimetro\nIdentificare servizio, ambiente e intervallo temporale.\n\n## Analisi\nRaggruppare gli errori ricorrenti, ricostruire la sequenza e verificare l’impatto.\n\n## Intervento\nProporre una correzione, verificarla in ambiente di prova e concordare il rilascio.\n\n## Evidenze\nDa estrarre dai log. Documento dimostrativo: nessun log è stato letto e nessun server è stato contattato.",
  },
];
const phaseText: Record<Phase, string> = {
  proposal: "Da concordare",
  waiting: "Serve il tuo contributo",
  ready: "Pronto a partire",
  review: "Da verificare",
  approved: "Approvato",
};
const busyDemo = new URLSearchParams(window.location.search).get("work-demo") === "busy";
const scaleDemo = new URLSearchParams(window.location.search).get("materials-demo") === "large";
const scaleProjects = Array.from({ length: 50 }, (_, i) => ({
  id: "scale-project-" + i,
  name: "Catalogo " + String(i + 1).padStart(2, "0"),
  brief: "Materiali e attività dimostrativi",
  teamId: "",
}));
type PrototypeSnapshot = {
  version: 1;
  savedAt: string;
  scenarios: ((typeof initialScenarios)[number] & { custom?: boolean })[];
  works: Work[];
  materials: ConversationMaterial[];
  spaceData: SpaceData;
  preferences: ConversationPreferences;
  seenResults: string[];
  attachmentMetadata: { file: File; id: string; date: string }[];
  view: {
    active: string | null;
    space: SpaceView | null;
    sidebarOpen: boolean;
    panel: boolean;
    viewer: string;
    selected?: string;
  };
};
const storageKey =
  busyDemo && new URLSearchParams(window.location.search).get("edition") === "complete"
    ? "complete"
    : busyDemo
      ? "busy"
      : scaleDemo
        ? "materials"
        : "normal";
export function ConversationWorkspace() {
  const [preferences, setPreferences] = useState<ConversationPreferences>(defaultPreferences);
  const [loaded, setLoaded] = useState(false);
  const [storageEnabled, setStorageEnabled] = useState(false);
  const [storageStatus, setStorageStatus] = useState("Caricamento…");
  const resetting = useRef(false);
  const attachmentIds = useRef(new WeakMap<File, string>());

  const [scenarios, setScenarios] = useState<
    ((typeof initialScenarios)[number] & { custom?: boolean })[]
  >(() =>
    busyDemo
      ? busyWorks().map((w) => ({
          ...initialScenarios[w.scenario]!,
          title: w.title,
          result: "Consegna: " + w.title,
          body:
            "# " +
            w.title +
            "\n\nDocumento dimostrativo di questo lavoro.\n\n## Risultato\nRiepilogo predisposto per la verifica del richiedente. Fonti e dati sono fittizi; nessuna elaborazione reale è stata eseguita.",
        }))
      : initialScenarios,
  );
  const [viewer, setViewer] = useState("Fabio");
  const [assignee, setAssignee] = useState("");
  const materialDates = useRef(new WeakMap<File, string>());
  const [materials, setMaterials] = useState<ConversationMaterial[]>(() =>
    busyDemo
      ? busyMaterials()
      : scaleDemo
        ? Array.from({ length: 100 }, (_, i) => ({
            id: "scale-material-" + i,
            addedAt: new Date(Date.now() - i * 86400000).toISOString(),
            name: "Listino " + String(i + 1).padStart(3, "0") + ".txt",
            file: new File(["Dati dimostrativi"], "Listino " + (i + 1) + ".txt"),
            path: "Fornitore " + (Math.floor(i / 10) + 1) + "/Listino " + (i + 1) + ".txt",
            projectIds: [],
          }))
        : [],
  );
  const [works, setWorks] = useState<Work[]>(() =>
    busyDemo
      ? busyWorks().map((w, i) => ({ ...w, scenario: i }))
      : scaleDemo
        ? Array.from({ length: 100 }, (_, i) => ({
            id: "scale-work-" + i,
            title: "Verifica listini " + String(i + 1).padStart(3, "0"),
            projectId: scaleProjects[i % 50]!.id,
            scenario: i % 3,
            phase: "proposal" as const,
            due: "",
            messages: [],
            files: [],
            contribution: "",
            revision: 0,
            feedback: "",
          }))
        : [],
  );
  const [active, setActive] = useState<string | null>(null);
  const [workListOpen, setWorkListOpen] = useState(true);
  const [squadListOpen, setSquadListOpen] = useState(true);
  const [panel, setPanel] = useState(true);
  const searchShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 800);
  const [notifications, setNotifications] = useState(false);
  const [seenResults, setSeenResults] = useState<string[]>([]);
  const [preview, setPreview] = useState(false);
  const [settings, setSettings] = useState(false);
  const [space, setSpace] = useState<SpaceView | null>(
    busyDemo ? "Compiti" : scaleDemo ? "Materiali" : null,
  );
  const [spaceInitial, setSpaceInitial] = useState("");
  const [spaceSelected, setSpaceSelected] = useState("");
  const [spaceVersion, setSpaceVersion] = useState(0);
  const [spaceData, setSpaceData] = useState<SpaceData>({
    teams: busyDemo ? busyTeams : [],
    projects: busyDemo ? busyProjects : scaleDemo ? scaleProjects : [],
    routines: busyDemo ? busyRoutines : [],
  });
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (document.querySelector("dialog[open]:not(.cw-super-search)")) return;
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  function openSpace(view: SpaceView, initial = "", selected = "") {
    if (window.innerWidth <= 800) setSidebarOpen(false);
    if (selected || initial) setPanel(true);
    setSpace(view);
    setSpaceInitial(initial);
    setSpaceSelected(selected);
    setSpaceVersion((v) => v + 1);
    setNotifications(false);
  }

  const [planEdit, setPlanEdit] = useState<{ workId: string; plan: CatalogPlan } | null>(null);
  const [notice, setNotice] = useState("");
  const [contribution, setContribution] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const upload = useRef<HTMLInputElement>(null);
  const directory = useRef<HTMLInputElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const modal = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = modal.current;
    if (preview) element?.showModal();
    return () => element?.close();
  }, [preview]);
  useEffect(() => {
    let cancelled = false;
    readPrototype<PrototypeSnapshot>(storageKey)
      .then((saved) => {
        if (cancelled) return;
        if (saved) {
          if (
            saved.version !== 1 ||
            !Array.isArray(saved.works) ||
            !Array.isArray(saved.scenarios) ||
            !saved.spaceData ||
            saved.works.some((w) => !saved.scenarios[w.scenario])
          )
            throw new Error("Invalid snapshot");
          setScenarios(saved.scenarios);
          setWorks(saved.works);
          setMaterials(saved.materials);
          setSpaceData(saved.spaceData);
          setPreferences({ ...defaultPreferences, ...saved.preferences });
          setSeenResults(saved.seenResults || []);
          for (const entry of saved.attachmentMetadata || []) {
            attachmentIds.current.set(entry.file, entry.id);
            materialDates.current.set(entry.file, entry.date);
          }
          setActive(saved.view.active);
          setSpace(saved.view.space);
          setSidebarOpen(window.innerWidth > 800 && saved.view.sidebarOpen);
          setPanel(saved.view.panel);
          setViewer(saved.view.viewer);
          setSpaceSelected(saved.view.selected || "");
        }
        setStorageEnabled(true);
        setStorageStatus("Salvato in questo browser");
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setStorageStatus(
            "Salvataggio non disponibile: le modifiche restano solo in questa sessione.",
          );
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!loaded || !storageEnabled || resetting.current) return;
    setStorageStatus("Salvataggio…");
    const timer = setTimeout(() => {
      if (resetting.current) return;
      const snapshot: PrototypeSnapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        scenarios,
        works,
        materials,
        spaceData,
        preferences,
        seenResults,
        attachmentMetadata: works
          .flatMap((w) => w.files)
          .map((file) => ({
            file,
            id: attachmentIds.current.get(file) || crypto.randomUUID(),
            date: materialDates.current.get(file) || new Date().toISOString(),
          })),
        view: { active, space, sidebarOpen, panel, viewer, selected: spaceSelected },
      };
      savePrototype(storageKey, snapshot)
        .then(() => setStorageStatus("Salvato in questo browser"))
        .catch(() =>
          setStorageStatus(
            "Salvataggio non riuscito. Esporta una copia dalle impostazioni prima di chiudere.",
          ),
        );
    }, 250);
    return () => clearTimeout(timer);
  }, [
    loaded,
    storageEnabled,
    scenarios,
    works,
    materials,
    spaceData,
    preferences,
    seenResults,
    active,
    space,
    sidebarOpen,
    panel,
    viewer,
    spaceSelected,
  ]);
  const work = works.find((w) => w.id === active);
  const visibleWorks = works.filter((w) => !w.archived);
  const scenario = work ? scenarios[work.scenario]! : null;
  function workStatus(w: Work) {
    if (w.request?.status === "pending") return `Aspetta ${w.request.to}`;
    return isHumanMember(scenarios[w.scenario]!.agent, spaceData.profiles)
      ? w.phase === "ready"
        ? "Da svolgere"
        : w.phase === "proposal"
          ? "Da assegnare"
          : phaseText[w.phase]
      : w.phase === "approved" && w.autoDelivered
        ? "Consegnato"
        : phaseText[w.phase];
  }
  const pending = works
    .filter((w) => !w.coordinatedBy && !w.archived)
    .filter((w) =>
      w.request?.status === "pending"
        ? w.request.to === viewer
        : isHumanMember(scenarios[w.scenario]!.agent, spaceData.profiles)
          ? (w.phase === "ready" && scenarios[w.scenario]!.agent === viewer) ||
            (w.phase === "review" && (w.requester || "Fabio") === viewer)
          : (w.phase === "waiting" && (w.requester || "Fabio") === viewer) ||
            (w.phase === "review" && (w.reviewer || w.requester || "Fabio") === viewer),
    );
  const completedNotices = works.filter(
    (w) =>
      preferences.resultNotifications &&
      !w.archived &&
      !w.coordinatedBy &&
      w.phase === "approved" &&
      (w.requester || "Fabio") === viewer &&
      !seenResults.includes(`${viewer}:${w.id}`),
  );
  const notificationCount = pending.length + completedNotices.length;
  function patch(change: Partial<Work>) {
    if (change.phase === "review")
      setSeenResults((current) => current.filter((key) => !key.endsWith(`:${active}`)));
    setWorks((all) => all.map((w) => (w.id === active ? { ...w, ...change } : w)));
  }
  const [destination, setDestination] = useState<{
    id: string;
    selector: string;
    stamp: number;
  } | null>(null);
  function open(id: string | null, selector = "") {
    if (window.innerWidth <= 800) setSidebarOpen(false);
    if (id) setDestination({ id, selector, stamp: Date.now() });
    if (id && works.some((w) => w.id === id && w.phase === "approved"))
      setSeenResults((current) => [...new Set([...current, `${viewer}:${id}`])]);
    setAssignee("");
    setSpace(null);
    setActive(id);
    setNotifications(false);
    setPreview(false);
    setContribution("");
    setFiles([]);
    setNotice("");
    setPanel(true);
  }
  useEffect(() => {
    history.current?.scrollTo({
      top: history.current.scrollHeight,
      behavior:
        preferences.motion && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "smooth"
          : "instant",
    });
  }, [work?.messages.length, active, preferences.motion]);
  useEffect(() => {
    if (!destination || active !== destination.id || space) return;
    const frame = requestAnimationFrame(() => {
      const selector =
        destination.selector ||
        (work?.request?.status === "pending"
          ? "[data-chat-request]"
          : work?.phase === "review" || work?.phase === "approved"
            ? "[data-chat-delivery]"
            : ".cw-message:last-of-type");
      const element = history.current?.querySelector<HTMLElement>(selector);
      if (element) {
        element.scrollIntoView({ block: "start", behavior: "instant" });
        element.tabIndex = -1;
        element.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [destination, active, space, work?.request?.status, work?.phase]);
  function create(
    index: number,
    text?: string,
    attachments: File[] = [],
    projectId?: string,
    override?: (typeof scenarios)[number],
  ) {
    if (spaceData.removedPeople?.includes((override || scenarios[index]!).agent)) {
      setNotice("Questo agente è stato eliminato. Scegli un altro collaboratore.");
      return;
    }
    const s = override || scenarios[index]!;
    const id = crypto.randomUUID();
    const coordinated =
      s.agent === "Marta" &&
      /catalog/i.test(text || "") &&
      /\bvera\b/i.test(text || "") &&
      /prezz/i.test(text || "");
    setWorks((all) => [
      ...all,
      {
        id,
        scenario: index,
        requester: viewer,
        ...(!isHumanMember(s.agent, spaceData.profiles)
          ? {
              catalogPlan: {
                completed: 0,
                steps: coordinated
                  ? [
                      { id: crypto.randomUUID(), title: "Controllare i prezzi", agent: "Vera" },
                      { id: crypto.randomUUID(), title: "Preparare la bozza", agent: "Marta" },
                    ]
                  : s.steps.map((title) => ({ id: crypto.randomUUID(), title, agent: s.agent })),
              },
              reviewer: viewer,
              autonomy: "supervised" as const,
            }
          : {}),
        ...(projectId ? { projectId } : {}),
        title: s.custom && text ? text.slice(0, 100) : s.title,
        phase: "proposal",
        due: "",
        messages: isHumanMember(s.agent, spaceData.profiles)
          ? [{ who: "you", sender: viewer, text: text || s.initial }]
          : [
              { who: "you", text: text || s.initial },
              {
                who: "agent",
                text: coordinated
                  ? "Nella simulazione Marta prepara il catalogo, Vera controlla i prezzi e tu approvi prima della consegna. Propongo il controllo dei listini prima della bozza: puoi cambiare l’ordine nel piano. Aggiungi la cartella dei materiali per avviare."
                  : `Posso occuparmene. Ti propongo ${s.outcome.charAt(0).toLowerCase() + s.outcome.slice(1)} Il piano è qui accanto: puoi modificarlo prima di affidarmi il lavoro.`,
              },
            ],
        files: [
          ...new Set([
            ...attachments,
            ...library
              .filter((m) => projectId && m.projectIds.includes(projectId) && m.file)
              .map((m) => m.file!),
          ]),
        ],
        materialIds: library
          .filter((m) => projectId && m.projectIds.includes(projectId) && !m.file)
          .map((m) => m.id),
        contribution: "",
        revision: 1,
        feedback: "",
      },
    ]);
    open(id);
    return id;
  }
  function updatePlan(next: CatalogPlan, starting = false) {
    if (!work?.catalogPlan || work.phase === "approved") return;
    const old = work.catalogPlan;
    if (
      next.completed !== old.completed ||
      old.steps
        .slice(0, old.completed)
        .some((step, i) => JSON.stringify(next.steps[i]) !== JSON.stringify(step))
    )
      return;
    setPlanEdit(null);
    const running = starting || work.phase !== "proposal";
    const additions: Work[] = [];
    const specs: typeof scenarios = [];
    const steps = next.steps.map((step, i) => {
      if (!running || i < next.completed) return step;
      const previous = works.find((w) => w.id === step.childId);
      const scenarioIndex =
        previous &&
        previous.title === step.title &&
        scenarios[previous.scenario]?.agent === step.agent
          ? previous.scenario
          : scenarios.length + specs.length;
      if (!previous || scenarioIndex >= scenarios.length)
        specs.push({
          ...initialScenarios[0]!,
          custom: true,
          agent: step.agent || "Da assegnare",
          role: "Passaggio del piano",
          title: step.title,
          initial: step.title,
          outcome: step.title,
          result: step.title,
          body: "# " + step.title + "\n\nRisultato dimostrativo del piano.",
          steps: [step.title],
        });
      const childId = step.childId || crypto.randomUUID();
      additions.push({
        ...previous,
        id: childId,
        coordinatedBy: work.id,
        scenario: scenarioIndex,
        title: step.title,
        phase: i === next.completed ? "ready" : "waiting",
        requester: work.requester || viewer,
        reviewer: work.requester || viewer,
        projectId: work.projectId || "",
        due: work.due,
        files: [...work.files],
        materialIds: [...(work.materialIds || [])],
        messages: previous?.messages || [{ who: "you", text: step.title }],
        contribution: work.contribution,
        revision: 1,
        feedback: "",
      });
      return { ...step, childId };
    });
    if (specs.length) setScenarios((current) => [...current, ...specs]);
    setWorks((current) => [
      ...current
        .filter(
          (w) =>
            w.coordinatedBy !== work.id ||
            steps.slice(0, next.completed).some((s) => s.childId === w.id),
        )
        .map((w): Work =>
          w.id === work.id
            ? {
                ...w,
                catalogPlan: { ...next, steps },
                phase: running
                  ? next.completed === steps.length
                    ? "review"
                    : "ready"
                  : "proposal",
                autonomy: "supervised",
                reviewer: work.requester || viewer,
                messages: [
                  ...w.messages,
                  {
                    who: "agent" as const,
                    text: starting
                      ? "Piano avviato nella demo. Ogni passaggio ha un compito collegato; la consegna richiede la tua approvazione."
                      : "Piano aggiornato. I passaggi conclusi sono conservati.",
                  },
                ],
              }
            : w,
        ),
      ...additions,
    ]);
  }
  function confirm() {
    if (scenario && spaceData.removedPeople?.includes(scenario.agent)) {
      setNotice("Agente eliminato: non puoi avviare questo lavoro.");
      return;
    }
    if (!work || !scenario) return;
    const ready = work.files.length > 0 || !!work.contribution.trim();
    if (work.catalogPlan) {
      if (
        !ready ||
        !work.catalogPlan.steps.length ||
        work.catalogPlan.steps.some((s) => !s.agent || spaceData.removedPeople?.includes(s.agent))
      )
        return;
      updatePlan(work.catalogPlan, true);
      return;
    }
    patch({
      phase: ready ? "ready" : "waiting",
      ...(!ready
        ? {
            request: {
              to: work.requester || "Fabio",
              need: `${scenario.input}. ${scenario.help}`,
              status: "pending" as const,
            },
          }
        : {}),
      messages: [
        ...work.messages,
        {
          who: "agent",
          text: ready
            ? "Ho ricevuto i materiali. Il lavoro è pronto a partire nella simulazione."
            : `Per cominciare mi serve: ${scenario.input.toLowerCase()}. Ti ho lasciato una richiesta qui accanto; puoi rispondere adesso o tornare più tardi.`,
        },
      ],
    });
  }
  function deliver(text = contribution, attachments = files) {
    if (scenario && spaceData.removedPeople?.includes(scenario.agent)) {
      setNotice("Agente eliminato: scegli un altro collaboratore per proseguire.");
      return;
    }
    if (!work || work.request?.status === "pending" || (!text.trim() && !attachments.length))
      return;
    patch({
      phase: "ready",
      contribution: text,
      files: [...work.files, ...attachments],
      messages: [
        ...work.messages,
        { who: "you", text: text || `Ho allegato ${attachments.length} file.` },
        {
          who: "agent",
          text: "Contributo ricevuto e collegato al lavoro. La tua richiesta è chiusa; il compito è pronto. Nella demo puoi ora provare l’arrivo del risultato.",
        },
      ],
    });
    setContribution("");
    setFiles([]);
  }
  function approvePlan() {
    if (!work || work.phase !== "review" || viewer !== (work.reviewer || work.requester || "Fabio"))
      return;
    patch({
      phase: "approved",
      approvedBy: viewer,
      autoDelivered: false,
      messages: [
        ...work.messages,
        { who: "you", sender: viewer, text: "Approvo questa bozza." },
        {
          who: "agent",
          text: "Approvazione registrata. Il risultato rimane qui nella conversazione. Nessun invio esterno.",
        },
      ],
    });
  }
  function simulateQuestion() {
    if (!work?.catalogPlan || work.phase !== "ready") return;
    const step = work.catalogPlan.steps[work.catalogPlan.completed];
    if (!step) return;
    const need =
      scenario?.agent === "Marta"
        ? "Quale lingua deve avere la consegna: italiano, inglese o entrambe?"
        : scenario?.agent === "Vera"
          ? "Su quale paese devo concentrare il confronto?"
          : "Quale intervallo di tempo devo esaminare?";
    patch({
      phase: "waiting",
      request: { to: work.requester || viewer, need, status: "pending" },
      messages: [
        ...work.messages,
        { who: "agent", sender: step.agent, text: `Per proseguire con «${step.title}»: ${need}` },
      ],
    });
  }
  function simulate() {
    if (scenario && spaceData.removedPeople?.includes(scenario.agent)) {
      setNotice("L’agente è stato eliminato. Questo lavoro resta consultabile nello storico.");
      return;
    }
    if (!work || !scenario || work.request?.status === "pending") return;
    if (work.coordinatedBy) return;
    if (work.catalogPlan) {
      const plan = work.catalogPlan,
        step = plan.steps[plan.completed];
      if (!step || !step.agent || spaceData.removedPeople?.includes(step.agent)) {
        setNotice("Assegna il prossimo passaggio a un collaboratore disponibile.");
        return;
      }
      const completed = plan.completed + 1;
      const result =
        work.feedback && step.title.startsWith("Revisione:")
          ? `Revisione dimostrativa preparata secondo queste indicazioni: ${work.feedback}. Apri la nuova versione per verificarle. Nessuna riscrittura AI reale.`
          : scenario.agent === "Marta"
            ? /prezz|listin/i.test(step.title)
              ? "Esempio simulato: listino organizzato per prodotto, prezzo e disponibilità. Una voce senza prezzo è evidenziata come da confermare; non è stato inventato un importo. Nessun file reale è stato analizzato."
              : "Esempio simulato: bozza organizzata in copertina, schede prodotto e riepilogo prezzi. Le informazioni da confermare restano evidenziate. Il documento dimostrativo sarà disponibile alla consegna."
            : `Passaggio dimostrativo concluso: ${step.title}. Indicazioni utilizzate nella prova: ${work.contribution || "materiali allegati"}. Nessuna analisi reale dei materiali.`;
      setWorks((current) =>
        current.map((w) =>
          w.id === work.id
            ? {
                ...w,
                catalogPlan: {
                  ...plan,
                  completed,
                  steps: plan.steps.map((s) => (s.id === step.id ? { ...s, result } : s)),
                },
                phase: completed === plan.steps.length ? "review" : "ready",
                messages: [
                  ...w.messages,
                  { who: "agent" as const, sender: step.agent, text: result },
                  ...(completed === plan.steps.length
                    ? [
                        {
                          who: "agent" as const,
                          text: "Il piano è concluso nella demo. Verifica il risultato prima di approvare la consegna.",
                        },
                      ]
                    : []),
                ],
              }
            : w.id === step.childId
              ? {
                  ...w,
                  phase: "approved",
                  autoDelivered: true,
                  messages: [
                    ...w.messages,
                    { who: "agent" as const, sender: step.agent, text: result },
                  ],
                }
              : w.id === plan.steps[completed]?.childId
                ? { ...w, phase: "ready" }
                : w,
        ),
      );
      return;
    }
    patch({
      phase: work.autonomy === "autonomous" ? "approved" : "review",
      autoDelivered: work.autonomy === "autonomous",
      messages: [
        ...work.messages,
        {
          who: "agent",
          text:
            work.autonomy === "autonomous"
              ? `«${scenario.result}» consegnato in autonomia per questo incarico. Nessuna approvazione umana registrata. Risultato simulato, non un’elaborazione dei tuoi materiali.`
              : `La bozza «${scenario.result}» è pronta. Verifica assegnata a ${work.reviewer || work.requester || "Fabio"}. È un esempio simulato, non un’elaborazione dei tuoi materiali.`,
        },
      ],
    });
  }
  function startAssignment(name: string) {
    open(null);
    setAssignee(name);
  }
  function moveConversation(id: string, projectId: string) {
    if (projectId && !spaceData.projects.some((p) => p.id === projectId)) return;
    setWorks((current) => current.map((w) => (w.id === id ? { ...w, projectId } : w)));
  }
  function conversationActions(w: Work) {
    return (
      <ConversationActions
        title={w.title}
        projects={spaceData.projects}
        current={w.projectId || ""}
        onRename={(name) =>
          setWorks((current) =>
            current.map((item) => (item.id === w.id ? { ...item, title: name } : item)),
          )
        }
        {...(!w.coordinatedBy
          ? {
              onArchive: () => {
                setWorks((current) =>
                  current.map((item) =>
                    item.id === w.id || item.coordinatedBy === w.id
                      ? { ...item, archived: true }
                      : item,
                  ),
                );
                setSpaceData((current) => ({
                  ...current,
                  routines: current.routines.map((r) =>
                    r.workId === w.id ? { ...r, active: false } : r,
                  ),
                }));
                if (active === w.id) {
                  open(null);
                  openSpace("Compiti");
                }
                setNotice("Conversazione archiviata. Puoi ripristinarla dalle impostazioni.");
              },
              onDelete: () => {
                const removed = new Set(
                  works
                    .filter((item) => item.id === w.id || item.coordinatedBy === w.id)
                    .map((item) => item.id),
                );
                setMaterials([...library]);
                setWorks((current) =>
                  current
                    .filter((item) => !removed.has(item.id))
                    .map((item) =>
                      item.request?.childId && removed.has(item.request.childId)
                        ? {
                            ...item,
                            phase: "waiting",
                            request: {
                              to: item.requester || "Fabio",
                              need:
                                "Il contributo collegato è stato eliminato. Fornisci nuovamente: " +
                                item.request.need,
                              status: "pending",
                            },
                          }
                        : item,
                    ),
                );
                setSpaceData((current) => ({
                  ...current,
                  routines: current.routines.map((r) =>
                    removed.has(r.workId) ? { ...r, active: false } : r,
                  ),
                }));
                if (active && removed.has(active)) {
                  open(null);
                  openSpace("Compiti");
                }
              },
            }
          : {})}
        onMove={(id) => moveConversation(w.id, id)}
        onCreate={() => promoteWork(w)}
        onRepeat={() => {
          open(w.id);
          openSpace("Automazioni", "Ripeti questo lavoro ogni lunedì alle 9");
        }}
      />
    );
  }
  function promoteWork(target = work) {
    const work = target;
    if (!work) return;
    const id = crypto.randomUUID();
    setSpaceData((current) => ({
      ...current,
      projects: [
        ...current.projects,
        {
          id,
          name: work.title,
          brief: work.messages[0]?.text || work.title,
          teamId: "",
        },
      ],
    }));
    setWorks((current) => current.map((w) => (w.id === work.id ? { ...w, projectId: id } : w)));
    setMaterials((current) =>
      current.map((m) =>
        work.materialIds?.includes(m.id)
          ? { ...m, projectIds: [...new Set([...m.projectIds, id])] }
          : m,
      ),
    );
    openSpace("Progetti", "", id);
  }
  function createFreeWork(name: string, text: string, attachments: File[], projectId?: string) {
    const spec = {
      ...initialScenarios[0]!,
      agent: name,
      icon: name.slice(0, 1),
      role: memberProfile(name, spaceData.profiles).role,
      color: "sage",
      custom: true,
      title: text.slice(0, 100),
      initial: text,
      input: "Le informazioni necessarie per questo incarico",
      help: "Allega materiali o descrivi vincoli, fonti e risultato atteso. Se non servono altri materiali, scrivilo qui.",
      outcome: "Un risultato coerente con la richiesta, da verificare insieme.",
      steps: [
        "Concordare risultato, informazioni e vincoli",
        "Preparare il lavoro e segnalare eventuali dubbi",
        "Consegnare il risultato per la tua verifica",
      ],
      result: "Consegna dimostrativa",
      body:
        "# Consegna dimostrativa\n\n## Incarico\n" +
        text +
        "\n\n## Risultato\nIl motore non è collegato: nessun lavoro è stato eseguito. Questa scheda serve a provare revisione e approvazione.\n\n## Da verificare nel prodotto finale\nRisultato completo, materiali utilizzati, fonti, limiti e azioni proposte.",
    };
    const index = scenarios.length;
    setScenarios((current) => [...current, spec]);
    return create(index, text, attachments, projectId, spec);
  }
  function send(text: string, attachments: File[]) {
    const navigation = text
      .trim()
      .toLowerCase()
      .match(
        /^(?:apri|mostra|vai a|gestisci)\s+(?:(?:le|la|i|il|ai|alle)\s+)?(impostazioni|compiti|materiali|squadra|progetti|plugin|automazioni)$/,
      );
    if (navigation && !attachments.length) {
      const page = navigation[1]!;
      if (page === "impostazioni") setSettings(true);
      else openSpace((page.charAt(0).toUpperCase() + page.slice(1)) as SpaceView);
      return;
    }

    if (work?.catalogPlan && work.phase !== "approved" && /^sposta\s/i.test(text)) {
      const match = text.trim().match(/^sposta\s+(.+?)\s+(prima|dopo)\s+(?:di\s+)?(.+)$/i);
      const plan = work.catalogPlan;
      if (match) {
        const from = plan.steps.findIndex((s) =>
          s.title.toLowerCase().includes(match[1]!.toLowerCase()),
        );
        const target = plan.steps.findIndex((s) =>
          s.title.toLowerCase().includes(match[3]!.toLowerCase()),
        );
        if (from >= plan.completed && target >= plan.completed && from !== target) {
          const steps = plan.steps.filter((_, i) => i !== from);
          const to =
            steps.findIndex((s) => s.id === plan.steps[target]!.id) +
            (match[2]!.toLowerCase() === "dopo" ? 1 : 0);
          steps.splice(to, 0, plan.steps[from]!);
          setPlanEdit({ workId: work.id, plan: { ...plan, steps } });
          patch({
            messages: [
              ...work.messages,
              { who: "you", text },
              {
                who: "agent",
                text: "Ti propongo questo ordine. I passaggi già conclusi rimangono invariati.",
              },
            ],
          });
          setPanel(true);
          return;
        }
      }
      setNotice(
        "Per riordinare indica i titoli di due passaggi futuri: Sposta Tradurre il catalogo dopo Preparare la bozza.",
      );
      return;
    }

    if (
      work?.catalogPlan &&
      work.phase !== "approved" &&
      /^(aggiungi|inserisci)\b/i.test(text.trim())
    ) {
      const match = text
        .trim()
        .match(/^(?:aggiungi|inserisci)\s+(.+?)(?:\s+(prima|dopo)\s+(?:di\s+)?(.+))?$/i);
      if (match) {
        const names = [...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])];
        const agent = names.find((n) => text.toLowerCase().includes("@" + n.toLowerCase())) || "";
        const title = match[1]!.replace(/\s+(?:con\s+)?@[^@]+$/, "").trim();
        const anchor = (match[3] || "").replace(/\s+(?:con\s+)?@[^@]+$/, "").toLowerCase();
        const index = anchor
          ? work.catalogPlan.steps.findIndex((s) => s.title.toLowerCase().includes(anchor))
          : work.catalogPlan.steps.length;
        const position = index + (match[2]?.toLowerCase() === "dopo" ? 1 : 0);
        if (index < 0 || position < work.catalogPlan.completed) {
          setNotice(
            "Indica un passaggio futuro usando il suo titolo, oppure inseriscilo con + nel piano.",
          );
          return;
        }
        const steps = [...work.catalogPlan.steps];
        steps.splice(position, 0, { id: crypto.randomUUID(), title, agent });
        setPlanEdit({ workId: work.id, plan: { ...work.catalogPlan, steps } });
        patch({
          messages: [
            ...work.messages,
            { who: "you", text },
            {
              who: "agent",
              text: "Ecco la modifica proposta al piano. Controlla la posizione e applicala; puoi scegliere il collaboratore dal passaggio.",
            },
          ],
        });
        setPanel(true);
        return;
      }
    }

    if (scenario && spaceData.removedPeople?.includes(scenario.agent)) {
      setNotice("Agente eliminato: conversazione in sola consultazione.");
      return;
    }
    if (/crea.*(agente|collaboratore)/i.test(text) && !work) {
      openSpace("Nuovo collaboratore", text);
      return;
    }
    if (
      !attachments.length &&
      /crea.*(team|squadra)|crea.*progett|ripet|ogni luned|automatizza/i.test(text)
    ) {
      openSpace(
        /team|squadra/i.test(text) ? "Squadra" : /progett/i.test(text) ? "Progetti" : "Automazioni",
        text,
      );
      return;
    }
    if (!work) {
      if (
        /catalog/i.test(text) &&
        /\bmarta\b/i.test(text) &&
        /\bvera\b/i.test(text) &&
        /prezz/i.test(text)
      ) {
        create(0, text, attachments);
        return;
      }
      const mentioned = scenarios.find(
        (s) =>
          memberProfile(s.agent, spaceData.profiles).invitation !== "pending" &&
          text.toLowerCase().includes("@" + s.agent.toLowerCase()) &&
          !spaceData.removedPeople?.includes(s.agent),
      );
      if (assignee || mentioned) {
        createFreeWork(assignee || mentioned!.agent, text, attachments);
        return;
      }
      const index = /catalog|listin/i.test(text)
        ? 0
        : /ricerca|mercato|concorrent/i.test(text)
          ? 1
          : /log|error/i.test(text)
            ? 2
            : -1;
      if (index < 0) {
        setNotice(
          "Scegli a chi affidarlo: scrivi @ e seleziona un collaboratore, oppure apri la sua scheda e premi Affida un lavoro.",
        );
        return;
      }
      create(index, text, attachments);
      return;
    }
    if (work.request?.status === "pending") {
      if (work.request.to === viewer && !work.request.childId)
        fulfillContribution(text, attachments, []);
      else
        setNotice(
          `La richiesta è assegnata a ${work.request.to}. Apri il contributo nel pannello.`,
        );
      return;
    }
    if (work.phase === "waiting") {
      deliver(text, attachments);
      return;
    }
    if (work.phase === "review" && work.catalogPlan && text.trim()) {
      const next = {
        ...work.catalogPlan,
        steps: [
          ...work.catalogPlan.steps,
          {
            id: crypto.randomUUID(),
            title: "Revisione: " + text.trim(),
            agent: work.catalogPlan.steps.at(-1)?.agent || scenario!.agent,
          },
        ],
      };
      updatePlan(next);
      setWorks((current) =>
        current.map((w) =>
          w.id === work.id
            ? {
                ...w,
                feedback: text,
                revision: w.revision + 1,
                files: [...w.files, ...attachments],
                messages: [
                  ...w.messages,
                  { who: "you", text },
                  {
                    who: "agent",
                    text: "Ho aggiunto un passaggio di revisione. Il risultato precedente è conservato; nella demo puoi simulare la nuova consegna.",
                  },
                ],
              }
            : w,
        ),
      );
      return;
    }
    if (work.phase === "review") {
      if (!text.trim()) {
        setNotice("Scrivi cosa vorresti cambiare nella bozza.");
        return;
      }
      patch({
        feedback: text,
        revision: work.revision + 1,
        files: [...work.files, ...attachments],
        messages: [
          ...work.messages,
          { who: "you", text },
          {
            who: "agent",
            text: "Ho registrato la correzione nella bozza, nella sezione Indicazioni di revisione. Puoi riaprirla per verificarla. Il contenuto non viene riscritto da un modello in questa prova.",
          },
        ],
      });
      return;
    }
    patch({
      ...(work.catalogPlan && work.phase === "proposal" && text.trim()
        ? { contribution: [work.contribution, text].filter(Boolean).join("\n") }
        : {}),
      files: [...work.files, ...attachments],
      messages: [
        ...work.messages,
        { who: "you", text: text || `${attachments.length} file allegati.` },
        {
          who: "agent",
          text:
            work.phase === "proposal"
              ? "Indicazione conservata per il lavoro. Controlla i passaggi nel piano a destra e avvia quando sei pronto."
              : "Messaggio conservato nel lavoro. Questa prova non interpreta ulteriori istruzioni: usa l’azione a destra per continuare.",
        },
      ],
    });
  }
  function runRoutine(r: SpaceRoutine) {
    const source = works.find((w) => w.id === r.workId);
    if (
      !source ||
      !r.active ||
      source.archived ||
      spaceData.removedPeople?.includes(scenarios[source.scenario]!.agent)
    ) {
      setNotice(
        "Questa automazione non è disponibile. Controlla il lavoro di origine e il collaboratore.",
      );
      return;
    }
    if (
      source.catalogPlan &&
      (!source.catalogPlan.steps.length ||
        source.catalogPlan.steps.some(
          (step) =>
            !step.agent ||
            spaceData.removedPeople?.includes(step.agent) ||
            memberProfile(step.agent, spaceData.profiles).invitation === "pending",
        ))
    ) {
      setNotice(
        "Il piano contiene passaggi senza un collaboratore disponibile. Aggiorna il lavoro di origine prima di ripetere l’automazione.",
      );
      return;
    }
    const id = crypto.randomUUID();
    const runNumber = works.filter((w) => w.routineId === r.id).length + 1;
    const human = isHumanMember(scenarios[source.scenario]!.agent, spaceData.profiles);
    const phase =
      human || source.files.length || source.materialIds?.length || source.contribution
        ? "ready"
        : "waiting";
    const run: Work = {
      id,
      scenario: source.scenario,
      routineId: r.id,
      runNumber,
      startedAt: new Date().toISOString(),
      requester: source.requester || "Fabio",
      reviewer: source.reviewer || source.requester || "Fabio",
      autonomy: source.autonomy || "supervised",
      projectId: source.projectId || "",
      title: `${r.name} · Esecuzione ${runNumber}`,
      phase,
      due: "",
      files: [...source.files],
      materialIds: [...(source.materialIds || [])],
      contribution: source.contribution,
      revision: 1,
      feedback: "",
      messages: [
        {
          who: "you",
          sender: source.requester || "Fabio",
          text: source.messages[0]?.text || source.title,
        },
        {
          who: "agent",
          sender: "Homun",
          text: `Esecuzione ${runNumber} di «${r.name}» creata nella demo. Progetto, materiali e supervisione ripresi dal lavoro di origine. ${phase === "waiting" ? "Mancano le informazioni iniziali: la richiesta è nelle notifiche del richiedente." : "Puoi proseguire da qui."} Nessuna scadenza precedente o approvazione è stata riutilizzata.${source.contribution ? ` Informazioni di partenza: ${source.contribution}` : ""}`,
        },
      ],
    };
    const children: Work[] = [];
    if (source.catalogPlan && !human) {
      const specs = source.catalogPlan.steps.map((step) => ({
        ...initialScenarios[0]!,
        custom: true,
        agent: step.agent,
        role: "Passaggio del piano",
        title: step.title,
        initial: step.title,
        outcome: step.title,
        result: step.title,
        body: "# " + step.title + "\n\nRisultato dimostrativo di questa esecuzione.",
        steps: [step.title],
      }));
      run.catalogPlan = {
        completed: 0,
        steps: source.catalogPlan.steps.map((step, index) => {
          const childId = crypto.randomUUID();
          children.push({
            id: childId,
            coordinatedBy: id,
            scenario: scenarios.length + index,
            title: step.title,
            phase: phase === "ready" && index === 0 ? "ready" : "waiting",
            requester: run.requester!,
            reviewer: run.reviewer!,
            projectId: run.projectId!,
            due: "",
            files: [...run.files],
            materialIds: [...(run.materialIds || [])],
            contribution: run.contribution,
            revision: 1,
            feedback: "",
            messages: [{ who: "you", text: step.title }],
          });
          return { id: crypto.randomUUID(), title: step.title, agent: step.agent, childId };
        }),
      };
      setScenarios((current) => [...current, ...specs]);
    }
    if (phase === "waiting")
      run.request = {
        to: run.requester || viewer,
        need: scenarios[source.scenario]!.input + ". " + scenarios[source.scenario]!.help,
        status: "pending",
      };
    setWorks((current) => [...current, run, ...children]);
    open(id);
  }
  const library = [...materials];
  works.forEach((w) =>
    w.files.forEach((file) => {
      if (!materialDates.current.has(file))
        materialDates.current.set(file, new Date().toISOString());
      if (!attachmentIds.current.has(file)) attachmentIds.current.set(file, crypto.randomUUID());
      if (!library.some((m) => m.file === file))
        library.push({
          id: attachmentIds.current.get(file)!,
          name: file.name,
          addedAt: materialDates.current.get(file)!,
          file,
          path: file.webkitRelativePath || file.name,
          projectIds: w.projectId ? [w.projectId] : [],
        });
    }),
  );
  function updateMaterial(item: ConversationMaterial) {
    setMaterials((current) =>
      current.some((m) => m.id === item.id)
        ? current.map((m) => (m.id === item.id ? item : m))
        : [...current, item],
    );
  }
  function removeMaterial(id: string) {
    const item = library.find((m) => m.id === id);
    setMaterials((current) => current.filter((m) => m.id !== id));
    setWorks((current) =>
      current.map((w) => ({
        ...w,
        files: w.files.filter((f) => f !== item?.file),
        materialIds: (w.materialIds || []).filter((mid) => mid !== id),
      })),
    );
  }
  function linkMaterial(id: string, workId: string) {
    const item = library.find((m) => m.id === id);
    if (!item) return;
    updateMaterial(item);
    setWorks((current) =>
      current.map((w) =>
        w.id === workId
          ? {
              ...w,
              materialIds: [...new Set([...(w.materialIds || []), id])],
              files: item.file && !w.files.includes(item.file) ? [...w.files, item.file] : w.files,
            }
          : w,
      ),
    );
  }
  function moveWork(id: string, phase: string) {
    const target = works.find((w) => w.id === id);
    if (!target) return "Compito non disponibile.";
    if (target.request?.status === "pending")
      return `Serve prima il contributo di ${target.request.to}.`;
    if (spaceData.removedPeople?.includes(scenarios[target.scenario]!.agent))
      return "L’agente è stato eliminato: il lavoro rimane nello storico.";
    if (target.phase === phase) return "Il compito è già in questa colonna.";
    if (
      viewer !==
      (isHumanMember(scenarios[target.scenario]!.agent, spaceData.profiles)
        ? target.requester || "Fabio"
        : target.reviewer || target.requester || "Fabio")
    )
      return "La verifica spetta al supervisore di questo lavoro.";
    const allowed =
      (target.phase === "review" && phase === "approved") ||
      (target.phase === "approved" && phase === "review");
    if (!allowed)
      return "Apri la conversazione per fornire il contributo o generare il risultato prima di cambiare stato.";
    if (phase === "review")
      setSeenResults((current) => current.filter((key) => !key.endsWith(`:${id}`)));
    setWorks((current) =>
      current.map((w) =>
        w.id === id
          ? {
              ...w,
              phase: phase as Phase,
              autoDelivered: false,
              approvedBy: phase === "approved" ? viewer : "",
              messages: [
                ...w.messages,
                {
                  who: "you",
                  text:
                    phase === "approved"
                      ? "Ho verificato e approvato il risultato dalla bacheca."
                      : "Riapro il risultato per una nuova verifica.",
                },
              ],
            }
          : w,
      ),
    );
    return phase === "approved"
      ? "Risultato approvato. Nessuna azione esterna."
      : "Risultato riaperto per la verifica.";
  }
  function requestContribution(to: string, need: string) {
    if (
      !work ||
      (work.request?.status === "pending" && work.request.childId) ||
      (viewer !== (work.requester || "Fabio") && viewer !== work.reviewer)
    )
      return;
    const childId = isHumanMember(to, spaceData.profiles)
      ? ""
      : createFreeWork(to, need, [], work.projectId);
    const request = { to, need, status: "pending" as const, ...(childId ? { childId } : {}) };
    setWorks((all) =>
      all.map((w) =>
        w.id === work.id
          ? {
              ...w,
              phase: "waiting",
              request,
              messages: [
                ...w.messages,
                { who: "you", sender: viewer, text: `Richiesta a ${to}: ${need}` },
              ],
            }
          : w,
      ),
    );
  }
  function fulfillContribution(text: string, attachments: File[], ids: string[]) {
    if (
      !work?.request ||
      work.request.status !== "pending" ||
      work.request.to !== viewer ||
      work.request.childId
    )
      return;
    const selected = library.filter((m) => ids.includes(m.id));
    if (!text.trim() && !attachments.length && !selected.length) return;
    patch({
      phase: "ready",
      request: { ...work.request, status: "resolved" },
      files: [
        ...new Set([
          ...work.files,
          ...attachments,
          ...selected.flatMap((m) => (m.file ? [m.file] : [])),
        ]),
      ],
      materialIds: [
        ...new Set([
          ...(work.materialIds || []),
          ...selected.filter((m) => !m.file).map((m) => m.id),
        ]),
      ],
      contribution: [work.contribution, text].filter(Boolean).join("\n"),
      messages: [
        ...work.messages,
        {
          who: "you",
          sender: viewer,
          text:
            text ||
            `Contributo: ${[...attachments.map((f) => f.name), ...selected.map((m) => m.name)].join(", ")}`,
        },
        {
          who: "agent",
          sender: "Homun",
          text: "Contributo collegato. La richiesta è chiusa e il lavoro può riprendere nella demo. Il contenuto non è stato valutato da un modello.",
        },
      ],
    });
  }
  useEffect(() => {
    const resumable = works.filter(
      (w) =>
        w.request?.status === "pending" &&
        w.request.childId &&
        works.some((c) => c.id === w.request?.childId && c.phase === "approved"),
    );
    if (!resumable.length) return;
    setWorks((all) =>
      all.map((w) => {
        if (!resumable.some((r) => r.id === w.id) || !w.request) return w;
        return {
          ...w,
          phase: "ready",
          request: { ...w.request, status: "resolved" },
          messages: [
            ...w.messages,
            {
              who: "agent",
              sender: "Homun",
              text: `Contributo di ${w.request.to} pronto. Il risultato resta nella conversazione collegata; questo lavoro può riprendere.`,
            },
          ],
        };
      }),
    );
  }, [works]);
  const contributionPanel = work ? (
    <ConversationContribution
      key={work.id + (work.request?.need || "")}
      work={work}
      viewer={viewer}
      profiles={spaceData.profiles}
      members={[...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])]
        .filter(
          (name) =>
            name !== scenarios[work.scenario]!.agent &&
            !spaceData.removedPeople?.includes(name) &&
            memberProfile(name, spaceData.profiles).invitation !== "pending",
        )
        .map((name) => ({ name, role: memberProfile(name, spaceData.profiles).role }))}
      materials={library}
      onRequest={requestContribution}
      onDeliver={fulfillContribution}
      onOpen={open}
    />
  ) : null;
  const entries: SearchEntry[] = [
    ...library.map((m) => ({
      id: m.id,
      title: m.name,
      kind: "Materiali",
      context: m.path || "Nota",
      text: m.body || "",
      open: () => openSpace("Materiali", "", m.id),
    })),
    ...visibleWorks.map((w) => ({
      id: w.id,
      title: w.title,
      kind: "Lavori",
      context: `${scenarios[w.scenario]!.agent} · ${workStatus(w)}`,
      text: w.contribution,
      open: () => open(w.id),
    })),
    ...visibleWorks.flatMap((w) =>
      w.messages.map((m, i) => ({
        id: `${w.id}:message:${i}`,
        title: m.who === "you" ? "Tu" : scenarios[w.scenario]!.agent,
        kind: "Messaggi",
        context: w.title,
        text: m.text,
        open: () => {
          open(w.id, `[data-message="${w.id}:${i}"]`);
        },
      })),
    ),
    ...visibleWorks
      .filter((w) => w.phase === "review" || w.phase === "approved")
      .map((w) => ({
        id: `${w.id}:result`,
        title: w.humanResult ? "Risultato consegnato" : scenarios[w.scenario]!.result,
        kind: "Materiali",
        context: w.title,
        text: w.humanResult || scenarios[w.scenario]!.body,
        open: () => {
          open(w.id);
          if (!isHumanMember(scenarios[w.scenario]!.agent, spaceData.profiles)) setPreview(true);
        },
      })),
    ...spaceData.teams.map((t) => ({
      id: t.id,
      title: t.name,
      kind: "Team",
      context: t.members.join(", "),
      text: [t.brief, ...(t.notes || [])].join(" "),
      open: () => openSpace("Squadra", "", t.id),
    })),
    ...spaceData.projects.map((p) => ({
      id: p.id,
      title: p.name,
      kind: "Progetti",
      context: spaceData.teams.find((t) => t.id === p.teamId)?.name || "Senza squadra",
      text: [p.brief, ...(p.notes || [])].join(" "),
      open: () => openSpace("Progetti", "", p.id),
    })),
    ...spaceData.routines.map((r) => ({
      id: r.id,
      title: r.name,
      kind: "Automazioni",
      context: r.schedule,
      text: [r.active ? "attiva" : "pausa", ...(r.notes || [])].join(" "),
      open: () => openSpace("Automazioni", "", r.id),
    })),
    ...[...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])]
      .filter((n) => !spaceData.removedPeople?.includes(n))
      .map((n) => ({
        id: `person:${n}`,
        title: n,
        kind: "Collaboratori",
        context: memberProfile(n, spaceData.profiles).role,
        text: JSON.stringify(memberProfile(n, spaceData.profiles)),
        open: () => {
          openSpace("Squadra", "", `person:${n}`);
        },
      })),
  ];
  function download() {
    if (!scenario || !work) return;
    const blob = new Blob(
      [scenario.body + (work.feedback ? `\n\n## Indicazioni di revisione\n${work.feedback}` : "")],
      { type: "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${scenario.result}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (!loaded)
    return (
      <div className="cw-loading" role="status">
        Apro il tuo spazio…
      </div>
    );
  return (
    <div
      className={`cw ${sidebarOpen ? "" : "cw-sidebar-closed"} ${preferences.textSize === "large" ? "cw-large-text" : ""} ${preferences.motion ? "" : "cw-reduce-motion"}`}
    >
      {settings && (
        <ConversationSettings
          value={preferences}
          onSave={setPreferences}
          onClose={() => setSettings(false)}
          storageStatus={storageStatus}
          counts={{
            works: works.filter((w) => !w.coordinatedBy).length,
            projects: spaceData.projects.length,
            materials: library.length,
          }}
          archived={works.filter((w) => w.archived && !w.coordinatedBy)}
          onRestore={(id) =>
            setWorks((current) =>
              current.map((w) =>
                w.id === id || w.coordinatedBy === id ? { ...w, archived: false } : w,
              ),
            )
          }
          onNavigate={(page) => {
            setSettings(false);
            openSpace(page);
          }}
          onExport={() => {
            const data = {
              exportedAt: new Date().toISOString(),
              version: 1,
              preferences,
              spaceData,
              works,
              materials: library,
            };
            const blob = new Blob(
              [
                JSON.stringify(
                  data,
                  (_key, value) =>
                    value instanceof File
                      ? {
                          name: value.name,
                          size: value.size,
                          type: value.type,
                          path: value.webkitRelativePath,
                          contentIncluded: false,
                        }
                      : value,
                  2,
                ),
              ],
              { type: "application/json" },
            );
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "homun-prototipo.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
          onReset={async () => {
            resetting.current = true;
            try {
              await resetPrototype(storageKey);
              window.location.reload();
            } catch (error) {
              resetting.current = false;
              throw error;
            }
          }}
        />
      )}
      {searchOpen && <ConversationSearch entries={entries} onClose={() => setSearchOpen(false)} />}
      {sidebarOpen && (
        <button
          className="cw-mobile-backdrop"
          aria-label="Chiudi navigazione"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className="cw-sidebar" hidden={!sidebarOpen}>
        <div className="cw-sidebar-fixed">
          <div className="cw-sidebar-tools">
            <button
              aria-label="Cerca ovunque"
              title={`Cerca ovunque (${searchShortcut})`}
              onClick={() => setSearchOpen(true)}
            >
              <Search size={18} />
              <kbd>{searchShortcut}</kbd>
            </button>
            <button
              aria-label="Chiudi barra laterale"
              title="Chiudi barra laterale"
              onClick={() => setSidebarOpen(false)}
            >
              <PanelRightOpen size={18} />
            </button>
          </div>
          <button className="cw-new" onClick={() => open(null)}>
            <Plus size={17} /> Nuova conversazione
          </button>
        </div>
        <div className="cw-sidebar-scroll">
          <div className="cs-space-links">
            {(["Compiti", "Materiali", "Automazioni", "Plugin"] as SpaceView[]).map((v) => (
              <button className={space === v ? "active" : ""} key={v} onClick={() => openSpace(v)}>
                {v}
                <span>
                  {v === "Squadra"
                    ? spaceData.teams.length
                    : v === "Progetti"
                      ? spaceData.projects.length
                      : v === "Automazioni"
                        ? spaceData.routines.length
                        : v === "Materiali"
                          ? library.length
                          : v === "Compiti"
                            ? visibleWorks.length
                            : (spaceData.installedPlugins || []).length}
                </span>
              </button>
            ))}
          </div>
          <ConversationProjectNav
            projects={spaceData.projects}
            works={visibleWorks.filter((w) => !w.coordinatedBy)}
            onProject={(id) => openSpace("Progetti", "", id)}
            onWork={open}
            onAll={() => openSpace("Progetti")}
            onMove={moveConversation}
            actions={(id) => {
              const w = works.find((w) => w.id === id);
              return w ? conversationActions(w) : null;
            }}
          />
          <button
            className="cw-nav-label cw-section-toggle"
            aria-label="Lavori"
            aria-expanded={workListOpen}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("application/homun-work")) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              moveConversation(e.dataTransfer.getData("application/homun-work"), "");
            }}
            aria-controls="cw-sidebar-works"
            onClick={() => setWorkListOpen(!workListOpen)}
          >
            <span>Senza progetto</span>
            <span className="cw-section-count">
              {visibleWorks.filter((w) => !w.projectId && !w.coordinatedBy).length}
            </span>
            <ChevronDown size={14} className="cw-section-chevron" aria-hidden="true" />
          </button>
          <nav
            id="cw-sidebar-works"
            hidden={!workListOpen}
            className="cw-work-list"
            aria-label="Conversazioni"
          >
            {visibleWorks
              .filter((w) => !w.projectId && !w.coordinatedBy)
              .map((w) => (
                <div
                  key={w.id}
                  className="cv-chat-nav-row"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("application/homun-work", w.id)}
                >
                  <button className={w.id === active ? "selected" : ""} onClick={() => open(w.id)}>
                    <ConversationAvatar
                      name={scenarios[w.scenario]!.agent}
                      human={isHumanMember(scenarios[w.scenario]!.agent, spaceData.profiles)}
                    />
                    <span>
                      {w.title}
                      <small>{workStatus(w)}</small>
                    </span>
                    {(w.phase === "waiting" || w.phase === "review") && <i />}
                  </button>
                  {conversationActions(w)}
                </div>
              ))}
            {(spaceData.detachedChats || []).map((c) => (
              <button key={c.id} onClick={() => openSpace("Progetti", "", "loose:" + c.id)}>
                {c.title}
              </button>
            ))}
            {!works.some((w) => !w.projectId) && !spaceData.detachedChats?.length && (
              <p className="cw-nav-empty">Nessun lavoro senza progetto</p>
            )}
          </nav>
          <button
            className="cw-nav-label cw-section-toggle"
            aria-label="Squadra"
            aria-expanded={squadListOpen}
            aria-controls="cw-sidebar-squad"
            onClick={() => setSquadListOpen(!squadListOpen)}
          >
            <span>Squadra</span>
            <span className="cw-section-count">
              {
                scenarios.filter(
                  (s, i) =>
                    scenarios.findIndex((a) => a.agent === s.agent) === i &&
                    !spaceData.removedPeople?.includes(s.agent),
                ).length
              }
            </span>
            <ChevronDown size={14} className="cw-section-chevron" aria-hidden="true" />
          </button>
          <div id="cw-sidebar-squad" hidden={!squadListOpen} className="cw-team">
            <button className="cv-manage-team" onClick={() => openSpace("Squadra")}>
              Tutti i collaboratori e team <ArrowUpRight size={14} />
            </button>
            {scenarios
              .filter(
                (s, i) =>
                  scenarios.findIndex((a) => a.agent === s.agent) === i &&
                  !spaceData.removedPeople?.includes(s.agent),
              )
              .map((s) => (
                <button key={s.agent} onClick={() => openSpace("Squadra", "", `person:${s.agent}`)}>
                  <ConversationAvatar
                    name={s.agent}
                    human={isHumanMember(s.agent, spaceData.profiles)}
                  />
                  <span>
                    {s.agent}
                    <small>{memberProfile(s.agent, spaceData.profiles).role}</small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              ))}
          </div>
        </div>
        <div className="cw-sidebar-foot">
          <a href="/prototypes/first-work.html">
            <ArrowLeft size={14} /> Versione precedente
          </a>
          <button aria-label="Impostazioni dello spazio" onClick={() => setSettings(true)}>
            <span className="cw-user">{preferences.displayName.slice(0, 1)}</span>
            <span>
              {preferences.displayName}
              <small>{preferences.spaceName}</small>
            </span>
            <Settings2 size={17} />
          </button>
        </div>
      </aside>
      <main className={`cw-main ${panel ? "" : "cw-details-hidden"}`}>
        <header className="cw-topbar">
          {!sidebarOpen && (
            <button
              className="cw-icon"
              aria-label="Apri barra laterale"
              title="Apri barra laterale"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelRightClose size={19} />
            </button>
          )}
          <span>
            {space ? (
              space
            ) : work ? (
              <>
                <span className="cw-breadcrumb">Conversazioni / </span>
                {work.title}
              </>
            ) : (
              preferences.spaceName
            )}
          </span>
          <div>
            <button
              className="cw-icon"
              aria-label="Apri impostazioni"
              onClick={() => setSettings(true)}
            >
              <Settings2 size={18} />
            </button>
            <label className="cw-viewer">
              Vista demo{" "}
              <ConversationSelectField
                aria-label="Vista utente demo"
                value={viewer}
                onChange={(e) => {
                  setViewer(e.target.value);
                  setNotifications(false);
                }}
              >
                {[...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])]
                  .filter(
                    (n) =>
                      isHumanMember(n, spaceData.profiles) &&
                      !spaceData.removedPeople?.includes(n) &&
                      memberProfile(n, spaceData.profiles).invitation !== "pending",
                  )
                  .map((n) => (
                    <option key={n}>{n}</option>
                  ))}
              </ConversationSelectField>
            </label>
            <button
              className="cw-icon"
              aria-label={`Notifiche${notificationCount ? ` · ${notificationCount} aggiornamenti` : ""}`}
              onClick={() => setNotifications(!notifications)}
            >
              <Bell size={18} />
              {!!notificationCount && <b>{notificationCount}</b>}
            </button>
            {(work || space) && (
              <button
                className="cw-icon"
                aria-label={panel ? "Chiudi pannello dettagli" : "Apri pannello dettagli"}
                title={panel ? "Chiudi dettagli" : "Mostra dettagli"}
                aria-expanded={panel}
                onClick={() => setPanel(!panel)}
              >
                {panel ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
              </button>
            )}
          </div>
        </header>
        {notifications && (
          <section className="cw-notifications">
            <header>
              <strong>Notifiche</strong>
              <button
                className="cw-icon"
                aria-label="Chiudi notifiche"
                onClick={() => setNotifications(false)}
              >
                <X size={16} />
              </button>
            </header>
            {!notificationCount ? (
              <p>Niente in sospeso. Puoi concentrarti sul tuo lavoro.</p>
            ) : (
              pending.map((w) => (
                <button key={w.id} onClick={() => open(w.id)}>
                  <strong>
                    {w.request?.status === "pending"
                      ? w.request.need
                      : w.phase === "ready" &&
                          isHumanMember(scenarios[w.scenario]!.agent, spaceData.profiles)
                        ? "Nuovo incarico"
                        : w.phase === "waiting"
                          ? scenarios[w.scenario]!.input
                          : "Verifica il risultato"}
                  </strong>
                  <small>
                    {w.title} · {scenarios[w.scenario]!.agent}
                  </small>
                  <ArrowUpRight size={16} />
                </button>
              ))
            )}
            {completedNotices.length > 0 && (
              <>
                <strong>Risultati pronti</strong>
                {completedNotices.map((w) => (
                  <button key={w.id} onClick={() => open(w.id)}>
                    <strong>
                      {w.autoDelivered ? "Consegnato in autonomia" : "Risultato approvato"}
                    </strong>
                    <small>
                      {w.title} · {scenarios[w.scenario]!.agent}
                    </small>
                    <ArrowUpRight size={16} />
                  </button>
                ))}
              </>
            )}
          </section>
        )}
        {space === "Nuovo collaboratore" ? (
          <ConversationCreateMember
            names={[...spacePeople, ...Object.keys(spaceData.profiles || {})]}
            emails={Object.entries(spaceData.profiles || {})
              .filter(([name]) => !spaceData.removedPeople?.includes(name))
              .map(([, p]) => p.email || "")
              .filter(Boolean)}
            initial={spaceInitial}
            onReveal={() => setPanel(true)}
            onCreate={(name, profile) => {
              setSpaceData((current) => ({
                ...current,
                profiles: { ...current.profiles, [name]: profile },
              }));
              setScenarios((current) => [
                ...current,
                {
                  ...initialScenarios[0]!,
                  agent: name,
                  icon: name.slice(0, 1),
                  role: profile.role,
                  custom: true,
                },
              ]);
              openSpace("Squadra", "", `person:${name}`);
            }}
          />
        ) : space === "Compiti" ? (
          <ConversationTasks
            onReveal={() => setPanel(true)}
            onMove={moveWork}
            items={visibleWorks.map((w) => ({
              ...w,
              agent: scenarios[w.scenario]!.agent,
              status: workStatus(w),
              needsYou: pending.some((p) => p.id === w.id),
              project: spaceData.projects.find((p) => p.id === w.projectId)?.name || "",
              unavailable: !!spaceData.removedPeople?.includes(scenarios[w.scenario]!.agent),
            }))}
            onOpen={open}
            onDue={(id, due) =>
              setWorks((current) => current.map((w) => (w.id === id ? { ...w, due } : w)))
            }
          />
        ) : space === "Materiali" ? (
          <ConversationMaterials
            onReveal={() => setPanel(true)}
            key={spaceVersion}
            items={library}
            profiles={spaceData.profiles}
            contextWork={works.find((w) => w.id === spaceInitial)}
            people={[...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])].filter(
              (n) => !spaceData.removedPeople?.includes(n),
            )}
            onBack={open}
            projects={spaceData.projects}
            works={works
              .filter((w) => !spaceData.removedPeople?.includes(scenarios[w.scenario]!.agent))
              .map((w) => ({ ...w, agent: scenarios[w.scenario]!.agent }))}
            onBatchLink={(ids, targets) => {
              const selected = library.filter((m) => ids.includes(m.id));
              const projectIds = targets.filter((t) => t.kind === "project").map((t) => t.id);
              const workIds = targets.filter((t) => t.kind === "work").map((t) => t.id);
              setMaterials((current) => [
                ...current.filter((m) => !ids.includes(m.id)),
                ...selected.map((m) => ({
                  ...m,
                  projectIds: [...new Set([...m.projectIds, ...projectIds])],
                })),
              ]);
              setWorks((current) =>
                current.map((w) =>
                  workIds.includes(w.id)
                    ? {
                        ...w,
                        materialIds: [...new Set([...(w.materialIds || []), ...ids])],
                        files: [
                          ...new Set([
                            ...w.files,
                            ...selected.flatMap((m) => (m.file ? [m.file] : [])),
                          ]),
                        ],
                      }
                    : w,
                ),
              );
            }}
            onAdd={(items) => {
              setMaterials((current) => [...current, ...items]);
              if (spaceInitial)
                setWorks((current) =>
                  current.map((w) =>
                    w.id === spaceInitial
                      ? {
                          ...w,
                          materialIds: [
                            ...new Set([...(w.materialIds || []), ...items.map((i) => i.id)]),
                          ],
                          files: [...w.files, ...items.flatMap((i) => (i.file ? [i.file] : []))],
                        }
                      : w,
                  ),
                );
            }}
            onUpdate={updateMaterial}
            onBatchRemove={(ids) => {
              const files = new Set(
                library.filter((m) => ids.includes(m.id) && m.file).map((m) => m.file),
              );
              setMaterials((current) => current.filter((m) => !ids.includes(m.id)));
              setWorks((current) =>
                current.map((w) => ({
                  ...w,
                  files: w.files.filter((f) => !files.has(f)),
                  materialIds: (w.materialIds || []).filter((id) => !ids.includes(id)),
                })),
              );
            }}
            onRemove={removeMaterial}
            onLink={linkMaterial}
            initialId={spaceSelected}
          />
        ) : space === "Plugin" ? (
          <ConversationPlugins
            onReveal={() => setPanel(true)}
            data={spaceData}
            onChange={setSpaceData}
            onMember={(n) => openSpace("Squadra", "", `person:${n}`)}
          />
        ) : space ? (
          <ConversationSpace
            onCreateMember={() => openSpace("Nuovo collaboratore")}
            onAssign={startAssignment}
            onReveal={() => setPanel(true)}
            key={spaceVersion}
            view={space}
            data={spaceData}
            onChange={(next) => {
              const removed = spaceData.projects
                .filter((p) => !next.projects.some((n) => n.id === p.id))
                .map((p) => p.id);
              if (removed.length)
                setWorks((current) =>
                  current.map((w) =>
                    w.projectId && removed.includes(w.projectId) ? { ...w, projectId: "" } : w,
                  ),
                );
              if (removed.length)
                setMaterials((current) =>
                  current.map((m) => ({
                    ...m,
                    projectIds: m.projectIds.filter((id) => !removed.includes(id)),
                  })),
                );
              const deleted = next.removedPeople || [];
              if (deleted.includes(viewer)) setViewer("Fabio");
              setSpaceData({
                ...next,
                routines: next.routines.map((r) =>
                  works.some(
                    (w) => w.id === r.workId && deleted.includes(scenarios[w.scenario]!.agent),
                  )
                    ? { ...r, active: false }
                    : r,
                ),
              });
            }}
            works={(active
              ? [...works.filter((w) => w.id === active), ...works.filter((w) => w.id !== active)]
              : works
            )
              .filter((w) => !w.coordinatedBy && !w.archived)
              .map((w) => ({
                ...w,
                status: workStatus(w),
                unavailable: !!spaceData.removedPeople?.includes(scenarios[w.scenario]!.agent),
              }))}
            onWork={open}
            onProjectWork={createFreeWork}
            projectMaterials={library}
            onMaterial={(id) => openSpace("Materiali", "", id)}
            onRun={runRoutine}
            initial={spaceInitial}
            selectedId={spaceSelected}
          />
        ) : work && scenario && isHumanMember(scenario.agent, spaceData.profiles) ? (
          <ConversationHumanWork
            key={work.id + viewer}
            work={work}
            actions={conversationActions(work)}
            person={scenario.agent}
            viewer={viewer}
            onChange={patch}
            onMaterials={() => openSpace("Materiali", work.id)}
            context={
              <>
                {contributionPanel}
                {work.projectId && (
                  <button
                    className="cs-link"
                    onClick={() => openSpace("Progetti", "", work.projectId)}
                  >
                    Progetto: {spaceData.projects.find((p) => p.id === work.projectId)?.name} ↗
                  </button>
                )}
                {library
                  .filter((m) => work.materialIds?.includes(m.id))
                  .map((m) => (
                    <button
                      className="cs-example"
                      key={m.id}
                      onClick={() => openSpace("Materiali", "", m.id)}
                    >
                      Nota: {m.name} ↗
                    </button>
                  ))}
              </>
            }
            unavailable={!!spaceData.removedPeople?.includes(scenario.agent)}
          />
        ) : (
          <div className={`cw-stage ${work && panel ? "with-panel" : ""}`}>
            <section className="cw-conversation">
              {work && scenario && spaceData.removedPeople?.includes(scenario.agent) && (
                <p role="status" className="cw-hint">
                  Agente eliminato · conversazione conservata nello storico. Le nuove esecuzioni
                  sono disabilitate.
                </p>
              )}
              {work && scenario && (
                <div className="cw-conversation-head">
                  <ConversationAvatar
                    name={scenario.agent}
                    human={isHumanMember(scenario.agent, spaceData.profiles)}
                    large
                  />
                  <div>
                    <strong>{work.catalogPlan ? work.title : scenario.agent}</strong>
                    <span>
                      {work.catalogPlan ? "Conversazione del lavoro" : scenario.role} <i />{" "}
                      {work.autonomy === "autonomous"
                        ? "Autonomo su questo lavoro"
                        : "Sotto supervisione"}
                    </span>
                  </div>
                  <span className="cw-private">Conversazione di lavoro</span>
                  {conversationActions(work)}
                </div>
              )}
              <div className="cw-history" ref={history}>
                {!work ? (
                  <div className="cw-welcome">
                    <span className="cw-overline">MENO DA GESTIRE. PIÙ DA FARE.</span>
                    <h1>
                      {assignee ? (
                        <>
                          Cosa affidiamo
                          <br />
                          <em>a {assignee}?</em>
                        </>
                      ) : (
                        <>
                          Un pensiero in meno.
                          <br />
                          <em>Cominciamo da qui.</em>
                        </>
                      )}
                    </h1>
                    <p>
                      Racconta cosa vuoi ottenere.
                      <br />
                      La tua squadra ti aiuta a portarlo a termine.
                    </p>
                    {!assignee && (
                      <div className="cw-examples">
                        {scenarios.slice(0, 3).map(
                          (s, i) =>
                            !spaceData.removedPeople?.includes(s.agent) && (
                              <button key={s.title} onClick={() => create(i)}>
                                <ConversationAvatar
                                  name={s.agent}
                                  human={isHumanMember(s.agent, spaceData.profiles)}
                                />
                                <span>
                                  {
                                    [
                                      "Prepariamo il catalogo",
                                      "Studiamo il mercato",
                                      "Mettiamo ordine nei log",
                                    ][i]
                                  }
                                  <small>Con {s.agent}</small>
                                </span>
                                <ArrowUpRight size={17} />
                              </button>
                            ),
                        )}
                      </div>
                    )}
                    <span className="cw-example-note">
                      {assignee
                        ? "Descrivi obiettivo, risultato atteso e vincoli. Puoi allegare i materiali."
                        : "Tre esempi guidati, oppure scrivi @ per affidare un lavoro libero."}
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="cw-date">OGGI · IL LAVORO COMINCIA QUI</div>
                    {work.messages.map((m, i) => (
                      <article
                        key={i}
                        data-message={`${work.id}:${i}`}
                        className={`cw-message ${m.who}`}
                      >
                        <small>
                          {m.sender || (m.who === "you" ? work.requester || "Tu" : scenario!.agent)}
                        </small>
                        <p>{m.text}</p>
                      </article>
                    ))}
                    {work.catalogPlan &&
                      work.catalogPlan.steps.filter((step) => step.result).length > 0 && (
                        <div className="cc-chat-results">
                          {work.catalogPlan.steps
                            .filter((step) => step.result)
                            .map((step) => (
                              <details key={step.id}>
                                <summary>
                                  <Check size={15} />
                                  <span>
                                    {step.title}
                                    <small>{step.agent} · Concluso nella demo</small>
                                  </span>
                                </summary>
                                <p>{step.result}</p>
                                {step.childId && (
                                  <button className="cs-link" onClick={() => open(step.childId!)}>
                                    Apri il passaggio ↗
                                  </button>
                                )}
                              </details>
                            ))}
                        </div>
                      )}
                    {work.catalogPlan && work.request?.status === "pending" && (
                      <div data-chat-request>{contributionPanel}</div>
                    )}
                    {work.catalogPlan && (work.phase === "review" || work.phase === "approved") && (
                      <div className="cc-chat-proposal" data-chat-delivery>
                        <strong>
                          {work.phase === "approved"
                            ? "Risultato approvato"
                            : "La consegna è pronta"}{" "}
                          · v{work.revision}
                        </strong>
                        <p>{scenario!.result}</p>
                        <p className="cw-hint">
                          Anteprima dimostrativa.{" "}
                          {work.phase === "review"
                            ? "Apri il risultato, oppure scrivi in chat cosa vuoi cambiare."
                            : "Il risultato resta consultabile qui."}
                        </p>
                        <div className="cs-actions">
                          <button className="cw-secondary" onClick={() => setPreview(true)}>
                            Apri risultato
                          </button>
                          {work.phase === "review" && (
                            <button
                              className="cw-primary"
                              disabled={viewer !== (work.reviewer || work.requester || "Fabio")}
                              onClick={approvePlan}
                            >
                              Approva bozza
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {planEdit?.workId === work.id && (
                      <div className="cc-chat-proposal">
                        <strong>Modifica proposta</strong>
                        <ol>
                          {planEdit.plan.steps.map((s) => (
                            <li key={s.id}>
                              {s.title} · {s.agent || "Da assegnare"}
                            </li>
                          ))}
                        </ol>
                        <div className="cs-actions">
                          <button className="cw-primary" onClick={() => updatePlan(planEdit.plan)}>
                            Applica al piano
                          </button>
                          <button className="cs-link" onClick={() => setPlanEdit(null)}>
                            Annulla
                          </button>
                        </div>
                      </div>
                    )}
                    {work.phase === "approved" && (
                      <div className="cw-closed">
                        <Check size={17} />{" "}
                        {work.autoDelivered
                          ? "Risultato consegnato in autonomia."
                          : "Risultato approvato."}{" "}
                        Nessun invio esterno.
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="cw-composer">
                {assignee && (
                  <p className="cw-hint">
                    Nuovo incarico per <strong>{assignee}</strong> · descrivi il risultato che vuoi
                    ottenere.
                  </p>
                )}
                <StudioChatInput
                  key={active || "new"}
                  label="Messaggio alla squadra"
                  onSend={send}
                  references={scenarios
                    .filter(
                      (s, i) =>
                        memberProfile(s.agent, spaceData.profiles).invitation !== "pending" &&
                        scenarios.findIndex((a) => a.agent === s.agent) === i &&
                        !spaceData.removedPeople?.includes(s.agent),
                    )
                    .map((s) => ({
                      id: s.agent,
                      name: s.agent,
                      kind: "member",
                      description: s.role,
                    }))}
                />
                {notice && (
                  <p className="cw-notice" role="status">
                    {notice}
                    <button aria-label="Chiudi avviso" onClick={() => setNotice("")}>
                      <X size={14} />
                    </button>
                  </p>
                )}
                <div className="cw-composer-caption">
                  <span>
                    <Sparkles size={12} /> Scrivi naturalmente. Usa @ per un collaboratore.
                  </span>
                  <span title={storageStatus}>Demo · {storageStatus}</span>
                </div>
              </div>
            </section>
            {work && scenario && (
              <aside className="cw-workspace" aria-label="Il lavoro adesso">
                <div className="cw-panel-top">
                  <span className="cw-overline">IL LAVORO, ADESSO</span>
                  <span className={`cw-status ${work.phase}`}>{workStatus(work)}</span>
                </div>
                <h2 className={work.catalogPlan ? "cc-work-title" : ""}>{work.title}</h2>
                {work.catalogPlan && (
                  <ConversationCatalogPlan
                    key={"plan:" + work.id}
                    plan={work.catalogPlan}
                    reviewer={work.requester || viewer}
                    count={work.files.length}
                    inputLabel={scenario.input}
                    inputHelp={scenario.help}
                    contribution={work.contribution}
                    onContribution={(contribution) => patch({ contribution })}
                    proposal={work.phase === "proposal"}
                    approved={work.phase === "approved"}
                    blocked={work.request?.status === "pending"}
                    people={[
                      ...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})]),
                    ].filter((n) => !spaceData.removedPeople?.includes(n))}
                    profiles={spaceData.profiles}
                    onChange={updatePlan}
                    onFiles={(added) => patch({ files: [...work.files, ...added] })}
                    onLibrary={() => openSpace("Materiali", work.id)}
                    onChild={open}
                    onCreate={(name, role) => {
                      if (
                        [...spacePeople, ...Object.keys(spaceData.profiles || {})].some(
                          (n) => n.toLowerCase() === name.toLowerCase(),
                        )
                      )
                        return false;
                      setScenarios((current) => [
                        ...current,
                        {
                          ...initialScenarios[0]!,
                          custom: true,
                          agent: name,
                          role,
                          title: role,
                          initial: role,
                          outcome: role,
                          result: role,
                          steps: [role],
                        },
                      ]);
                      setSpaceData((current) => ({
                        ...current,
                        profiles: {
                          ...current.profiles,
                          [name]: {
                            kind: "agent",
                            role,
                            bio: role,
                            skills: [role],
                            tone: "Chiaro e sintetico",
                            plugins: [],
                          },
                        },
                      }));
                      return true;
                    }}
                  />
                )}

                {work.routineId && (
                  <button
                    className="cs-link"
                    onClick={() => openSpace("Automazioni", "", work.routineId)}
                  >
                    Apri automazione ↗
                  </button>
                )}
                {!work.catalogPlan && <p className="cw-outcome">{scenario.outcome}</p>}
                {work.projectId && (
                  <button
                    className="cs-link"
                    onClick={() => openSpace("Progetti", "", work.projectId)}
                  >
                    Progetto: {spaceData.projects.find((p) => p.id === work.projectId)?.name} ↗
                  </button>
                )}
                <div className="cw-owner" hidden={!!work.catalogPlan}>
                  <ConversationAvatar
                    name={scenario.agent}
                    human={isHumanMember(scenario.agent, spaceData.profiles)}
                  />
                  <span>
                    {scenario.agent}
                    <small>
                      {work.autonomy === "autonomous"
                        ? "Consegna autonoma"
                        : `Verifica: ${work.reviewer || work.requester || "Fabio"}`}
                    </small>
                  </span>
                </div>
                <details className="cw-details cw-supervision" hidden={!!work.catalogPlan}>
                  <summary>
                    Supervisione del lavoro <ChevronDown size={14} />
                  </summary>
                  <label>
                    Modalità
                    <ConversationSelectField
                      aria-label="Modalità del lavoro"
                      value={work.autonomy || "supervised"}
                      disabled={
                        !!work.catalogPlan ||
                        !!work.coordinatedBy ||
                        work.phase === "approved" ||
                        viewer !== (work.requester || "Fabio")
                      }
                      onChange={(e) =>
                        patch({ autonomy: e.target.value as "supervised" | "autonomous" })
                      }
                    >
                      <option value="supervised">Risultato da verificare</option>
                      <option value="autonomous">Consegna autonoma</option>
                    </ConversationSelectField>
                  </label>
                  <label>
                    Chi verifica
                    <ConversationSelectField
                      aria-label="Supervisore del lavoro"
                      value={work.reviewer || work.requester || "Fabio"}
                      disabled={
                        !!work.catalogPlan ||
                        !!work.coordinatedBy ||
                        work.phase === "approved" ||
                        viewer !== (work.requester || "Fabio")
                      }
                      onChange={(e) => patch({ reviewer: e.target.value })}
                    >
                      {[...new Set(["Fabio", "Giulia", ...Object.keys(spaceData.profiles || {})])]
                        .filter(
                          (name) =>
                            isHumanMember(name, spaceData.profiles) &&
                            !spaceData.removedPeople?.includes(name) &&
                            memberProfile(name, spaceData.profiles).invitation !== "pending",
                        )
                        .map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                    </ConversationSelectField>
                  </label>
                  <p className="cw-hint">
                    Vale solo per questo incarico. In autonomia il supervisore resta il riferimento
                    per eventuali verifiche. Cambiare modalità non approva una bozza già in
                    revisione.
                  </p>
                </details>
                {work.coordinatedBy && (
                  <div className="cw-hint">
                    <p>Questo passaggio è gestito nel piano del lavoro.</p>
                    <button className="cw-secondary" onClick={() => open(work.coordinatedBy!)}>
                      Apri il piano del lavoro ↗
                    </button>
                  </div>
                )}
                {!work.catalogPlan && contributionPanel}
                {work.catalogPlan && work.request?.status === "pending" && (
                  <p className="cw-hint">
                    Aspetta {work.request.to}. La richiesta e il campo per rispondere sono nella
                    chat.
                  </p>
                )}
                {work.coordinatedBy ? null : work.request?.status ===
                  "pending" ? null : work.phase === "proposal" ? (
                  <div className="cw-panel-body">
                    {!work.catalogPlan && (
                      <ol className="cw-plan">
                        {scenario.steps.map((s, i) => (
                          <li key={s}>
                            <span>{i + 1}</span>
                            {s}
                          </li>
                        ))}
                      </ol>
                    )}
                    <details className="cw-details">
                      <summary>
                        Modifica accordo <ChevronDown size={14} />
                      </summary>
                      <label>
                        Nome del lavoro
                        <input
                          value={work.title}
                          onChange={(e) => patch({ title: e.target.value })}
                        />
                      </label>
                      <label>
                        Scadenza facoltativa
                        <input
                          aria-label="Scadenza"
                          type="date"
                          value={work.due}
                          onChange={(e) => patch({ due: e.target.value })}
                        />
                      </label>
                    </details>
                    <p className="cw-hint">
                      {work.catalogPlan
                        ? ""
                        : work.files.length
                          ? `${work.files.length} allegati già collegati.`
                          : `Ti chiederò ${scenario.input.toLowerCase()} per iniziare.`}
                    </p>
                    <button
                      className="cw-primary"
                      disabled={
                        !work.title.trim() ||
                        (!!work.catalogPlan &&
                          ((!work.files.length && !work.contribution.trim()) ||
                            !work.catalogPlan.steps.length ||
                            work.catalogPlan.steps.some(
                              (s) => !s.agent || spaceData.removedPeople?.includes(s.agent),
                            )))
                      }
                      onClick={confirm}
                    >
                      {work.catalogPlan
                        ? "Avvia il piano della squadra"
                        : "Affida a " + scenario.agent}
                      <ArrowUpRight size={16} />
                    </button>
                  </div>
                ) : work.phase === "waiting" ? (
                  <div className="cw-request">
                    <span className="cw-overline">TOCCA A TE</span>
                    <h3>{scenario.input}</h3>
                    <p>{scenario.help}</p>
                    <textarea
                      aria-label="Il tuo contributo"
                      placeholder="Scrivi qui le informazioni o un link…"
                      value={contribution}
                      onChange={(e) => setContribution(e.target.value)}
                    />
                    <div className="cw-attach">
                      <button onClick={() => upload.current?.click()}>
                        <Paperclip size={15} /> File
                      </button>
                      <button onClick={() => directory.current?.click()}>
                        <FolderOpen size={15} /> Cartella
                      </button>
                    </div>
                    {files.map((f, i) => (
                      <div className="cw-file" key={i}>
                        <FileText size={14} />
                        <span>{f.webkitRelativePath || f.name}</span>
                        <button
                          aria-label={`Rimuovi ${f.name}`}
                          onClick={() => setFiles(files.filter((_, j) => j !== i))}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                    <button
                      className="cw-primary"
                      disabled={!contribution.trim() && !files.length}
                      onClick={() => deliver()}
                    >
                      Consegna a {scenario.agent}
                      <ArrowUpRight size={16} />
                    </button>
                    <small>Puoi rispondere anche direttamente in chat.</small>
                  </div>
                ) : work.phase === "ready" ? (
                  <div className="cw-ready">
                    <span className="cw-check">
                      <Check size={24} />
                    </span>
                    <h3>
                      {work.catalogPlan ? "Prossimo passaggio" : "Tutto pronto per cominciare."}
                    </h3>
                    <p>
                      {work.catalogPlan ? (
                        `${work.catalogPlan.steps[work.catalogPlan.completed]?.agent}: ${work.catalogPlan.steps[work.catalogPlan.completed]?.title}`
                      ) : (
                        <>
                          Il tuo contributo è collegato. {scenario.agent} ha il necessario per il
                          prossimo passaggio.
                        </>
                      )}
                    </p>
                    <div className="cw-simulation">
                      <span>PROVA IL SEGUITO</span>
                      <p>
                        Il motore non è ancora collegato. Simula l’arrivo di una bozza per provare
                        la revisione.
                      </p>
                      <button
                        className="cw-primary"
                        disabled={spaceData.removedPeople?.includes(scenario.agent)}
                        onClick={simulate}
                      >
                        <Play size={14} />{" "}
                        {work.catalogPlan
                          ? "Simula passaggio " +
                            (work.catalogPlan.completed + 1) +
                            " di " +
                            work.catalogPlan.steps.length
                          : "Simula risultato pronto"}
                      </button>
                      {work.catalogPlan && (
                        <button className="cw-secondary" onClick={simulateQuestion}>
                          Simula una domanda
                        </button>
                      )}
                    </div>
                  </div>
                ) : work.catalogPlan ? (
                  <p className="cw-hint">
                    {work.phase === "review"
                      ? "Tocca a te: verifica la consegna nella chat."
                      : "Consegna approvata. Puoi riaprire il risultato nella chat."}
                  </p>
                ) : (
                  <div className="cw-result">
                    <div className="cw-document" onClick={() => setPreview(true)}>
                      <FileText size={30} />
                      <span>DOCUMENTO · V{work.revision}</span>
                      <h3>{scenario.result}</h3>
                      <p>Anteprima dimostrativa</p>
                      <button className="cw-secondary" onClick={() => setPreview(true)}>
                        Apri documento <ArrowUpRight size={15} />
                      </button>
                    </div>
                    {work.phase === "review" ? (
                      <>
                        <p className="cw-hint">
                          Verifica assegnata a {work.reviewer || work.requester || "Fabio"}. Apri la
                          bozza; per proporre modifiche, scrivi nella chat.
                        </p>
                        <button
                          className="cw-primary"
                          disabled={viewer !== (work.reviewer || work.requester || "Fabio")}
                          onClick={() => {
                            if (viewer !== (work.reviewer || work.requester || "Fabio")) return;
                            patch({
                              approvedBy: viewer,
                              autoDelivered: false,
                              phase: "approved",
                              messages: [
                                ...work.messages,
                                { who: "you", sender: viewer, text: "Approvo questa bozza." },
                                {
                                  who: "agent",
                                  text: "Approvazione registrata. Il risultato resta disponibile qui; non è stato pubblicato né inviato.",
                                },
                              ],
                            });
                          }}
                        >
                          Approva bozza
                          <Check size={16} />
                        </button>
                      </>
                    ) : (
                      <p className="cw-approved">
                        <Check size={15} />{" "}
                        {work.autoDelivered
                          ? "Consegnato in autonomia"
                          : `Approvata da ${work.approvedBy || work.requester || "Fabio"}`}
                      </p>
                    )}
                  </div>
                )}
                {work.due && (
                  <p className="cw-due">
                    <Clock3 size={14} /> Entro{" "}
                    {new Date(work.due + "T12:00:00").toLocaleDateString("it-IT")}
                  </p>
                )}
                <button className="cs-link" onClick={() => openSpace("Materiali", work.id)}>
                  Collega materiali dalla raccolta ↗
                </button>
                {(work.materialIds || [])
                  .map((id) => library.find((m) => m.id === id))
                  .filter((m) => m && !m.file)
                  .map((m) => (
                    <button
                      key={m!.id}
                      className="cs-example"
                      onClick={() => openSpace("Materiali", "", m!.id)}
                    >
                      Nota: {m!.name} ↗
                    </button>
                  ))}
                {work.files.length > 0 && (
                  <details className="cw-details">
                    <summary>
                      <span>Materiali · {work.files.length}</span>
                      <ChevronDown size={14} />
                    </summary>
                    {work.files.map((f, i) => (
                      <p className="cw-file" key={i}>
                        <FileText size={13} />
                        {f.name}
                      </p>
                    ))}
                  </details>
                )}
                <details className="cw-details cw-cost">
                  <summary>
                    <span>Costi</span>
                    <ChevronDown size={14} />
                  </summary>

                  <p>
                    Nessun consumo AI reale. Limite indicativo per lavoro: €
                    {preferences.perWorkBudget}. Budget mensile: €{preferences.budget}. Le soglie
                    saranno applicate dal futuro motore.
                  </p>
                </details>
              </aside>
            )}
          </div>
        )}
      </main>
      <input
        ref={upload}
        hidden
        type="file"
        multiple
        onChange={(e) => {
          setFiles([...files, ...Array.from(e.target.files || [])]);
          e.target.value = "";
        }}
      />
      <input
        ref={directory}
        hidden
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        onChange={(e) => {
          setFiles([...files, ...Array.from(e.target.files || [])]);
          e.target.value = "";
        }}
      />
      {preview && work && scenario && (
        <dialog
          ref={modal}
          className="cw-overlay"
          aria-label="Anteprima risultato"
          onCancel={() => setPreview(false)}
          onClick={() => setPreview(false)}
        >
          <section
            aria-label="Anteprima risultato"
            className="cw-preview"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <span>
                Risultato · {scenario.agent} · v{work.revision}
              </span>
              <div>
                <button className="cw-icon" aria-label="Scarica documento" onClick={download}>
                  <Download size={18} />
                </button>
                <button
                  className="cw-icon"
                  aria-label="Chiudi anteprima"
                  onClick={() => setPreview(false)}
                >
                  <X size={19} />
                </button>
              </div>
            </header>
            <div className="cw-preview-body">
              <span className="cw-overline">BOZZA DIMOSTRATIVA</span>
              {scenario.body
                .split("\n")
                .filter(Boolean)
                .map((p, i) =>
                  p.startsWith("# ") ? (
                    <h1 key={i}>{p.slice(2)}</h1>
                  ) : p.startsWith("## ") ? (
                    <h3 key={i}>{p.slice(3)}</h3>
                  ) : (
                    <p key={i}>{p}</p>
                  ),
                )}
              {work.feedback && (
                <section className="cw-feedback">
                  <h3>Indicazioni di revisione</h3>
                  <p>{work.feedback}</p>
                  <small>Annotate nella demo; contenuto non riscritto automaticamente.</small>
                </section>
              )}
            </div>
            <footer>
              <button className="cw-secondary" onClick={() => setPreview(false)}>
                Torna alla conversazione
              </button>
            </footer>
          </section>
        </dialog>
      )}
    </div>
  );
}
