import { createSimulationActions } from "./conversation-simulation-actions";
import { ConversationSettings } from "./ConversationSettings";
import { defaultPreferences, type ConversationPreferences } from "./conversation-preferences";
import { resetPrototype } from "./conversation-storage";
import { type CatalogPlan } from "./ConversationCatalogPlan";
import { ConversationActions } from "./ConversationActions";
import { ConversationContribution } from "./ConversationContribution";
import { ConversationHumanWork } from "./ConversationHumanWork";
import { type ConversationMaterial } from "./ConversationMaterials";
import { memberProfile, isHumanMember } from "./conversation-members";
import {
  type SpaceData,
  type SpaceView,
  spacePeople,
} from "./ConversationSpace";
import { ConversationSearch } from "./ConversationSearch";
import { ConversationWorkspaceChatStage } from "./ConversationWorkspaceChatStage";
import { ConversationWorkspacePreview } from "./ConversationWorkspacePreview";
import { ConversationWorkspaceSidebar } from "./ConversationWorkspaceSidebar";
import { ConversationWorkspaceSpaceHost } from "./ConversationWorkspaceSpaceHost";
import { ConversationWorkspaceTopbar } from "./ConversationWorkspaceTopbar";
import {
  ConversationWorkspaceWorkPanel,
  registerPlanAgent,
} from "./ConversationWorkspaceWorkPanel";
import { initialScenarios, scenarioForWork } from "./conversation-scenarios";
import {
  applyBoardMove,
  boardMoveSuccessMessage,
  validateBoardMove,
} from "./conversation-board-move";
import { buildDemoBootstrap, resolveDemoMode } from "./conversation-demo-mode";
import { downloadPrototypeExport, downloadWorkResult } from "./conversation-export";
import { buildMaterialLibrary } from "./conversation-material-library";
import {
  buildConversationSearchEntries,
  openWorkResultPreview,
} from "./conversation-search-entries";
import {
  isCompletedNoticeForViewer,
  isPendingForViewer,
  workspaceWorkStatus,
} from "./conversation-work-status";
import { useConversationPrototypeStorage } from "./useConversationPrototypeStorage";
import { type Phase, type Work } from "./conversation-types";
import { useEffect, useReducer, useRef, useState } from "react";
import { ConversationEngineBanner } from "./ConversationEngineBanner";
import { useChatAutoScroll } from "@/hooks/useChatAutoScroll";
import { useEngineWorkspace } from "@/hooks/useEngineWorkspace";
import { useWorkDestinationScroll, type WorkDestination } from "@/hooks/useWorkDestinationScroll";
import { isEngineBackedWork } from "@/lib/conversation-engine-bridge";
import { sendEngineFirstMessage } from "@/lib/engine-first-send";
import { parseConversationNavigation } from "@/lib/conversation-navigation";
import {
  parsePlanInsert,
  parsePlanReorder,
  stripTrailingMention,
} from "@/lib/conversation-plan-commands";

import { projectWorkspaceData } from "@/lib/engine-project-projection";
export type { Work } from "./conversation-types";
const demoMode = resolveDemoMode();
const { storageKey } = demoMode;
const demoBootstrap = buildDemoBootstrap(demoMode);
export function ConversationWorkspace() {
  const [active, setActive] = useState<string | null>(null);
  const engine = useEngineWorkspace(active);
  const [preferences, setPreferences] = useState<ConversationPreferences>(defaultPreferences);
  const [loaded, setLoaded] = useState(false);
  const [storageEnabled, setStorageEnabled] = useState(false);
  const [storageStatus, setStorageStatus] = useState("Caricamento…");
  const attachmentIds = useRef(new WeakMap<File, string>());
  const materialDates = useRef(new WeakMap<File, string>());

  const [scenarios, setScenarios] = useState(() => demoBootstrap.scenarios);
  const [viewer, setViewer] = useState("Fabio");
  const [assignee, setAssignee] = useState("");
  const [materials, setMaterials] = useState<ConversationMaterial[]>(() => demoBootstrap.materials);
  const [works, setWorks] = useState<Work[]>(() => demoBootstrap.works);
  const [workListOpen, setWorkListOpen] = useState(true);
  const [squadListOpen, setSquadListOpen] = useState(true);
  const [panel, setPanel] = useState(true);
  const searchShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 800);
  const [notifications, setNotifications] = useState(false);
  const [seenResults, setSeenResults] = useState<string[]>([]);
  const [preview, setPreview] = useState(false);
  const [settings, setSettings] = useState(false);
  const [space, setSpace] = useState<SpaceView | null>(demoBootstrap.initialSpace);
  const [spaceInitial, setSpaceInitial] = useState("");
  const [spaceSelected, setSpaceSelected] = useState("");
  const [spaceVersion, setSpaceVersion] = useState(0);
  const [spaceData, setSpaceData] = useState<SpaceData>(() => demoBootstrap.spaceData);
  const displaySpaceData = projectWorkspaceData(engine.backend, spaceData, engine.projects);
  const [searchOpen, setSearchOpen] = useState(false);
  const { resetting } = useConversationPrototypeStorage({
    storageKey,
    loaded,
    setLoaded,
    storageEnabled,
    setStorageEnabled,
    setStorageStatus,
    scenarios,
    setScenarios,
    works,
    setWorks,
    materials,
    setMaterials,
    spaceData,
    setSpaceData,
    preferences,
    setPreferences,
    seenResults,
    setSeenResults,
    active,
    setActive,
    space,
    setSpace,
    sidebarOpen,
    setSidebarOpen,
    panel,
    setPanel,
    viewer,
    setViewer,
    spaceSelected,
    setSpaceSelected,
    attachmentIds,
    materialDates,
  });

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
  const work = (engine.backend === "engine" ? engine.works : works).find((w) => w.id === active);
  const visibleWorks = (engine.backend === "engine" ? engine.works : works).filter(
    (w) => !w.archived,
  );
  const scenario = work ? scenarioForWork(work, scenarios) : null;

  useEffect(() => {
    if (!active || (engine.backend === "engine" && !engine.loaded)) return;
    const catalog = engine.backend === "engine" ? engine.works : works;
    if (!catalog.some((w) => w.id === active)) setActive(null);
  }, [engine.backend, engine.loaded, engine.works, works, active]);

  function workStatus(w: Work) {
    return workspaceWorkStatus(w, scenarios, spaceData.profiles);
  }
  const pending = (engine.backend === "engine" ? engine.works : works).filter((w) =>
    isPendingForViewer(w, viewer, scenarios, spaceData.profiles),
  );
  const completedNotices = (engine.backend === "engine" ? engine.works : works).filter((w) =>
    isCompletedNoticeForViewer(w, viewer, preferences.resultNotifications, seenResults),
  );
  const notificationCount = pending.length + completedNotices.length;
  function patch(change: Partial<Work>) {
    if (isEngineBackedWork(work)) {
      setNotice(
        "Le modifiche di simulazione non si applicano a questo lavoro. Usa la chat.",
      );
      return;
    }
    if (change.phase === "review")
      setSeenResults((current) => current.filter((key) => !key.endsWith(`:${active}`)));
    setWorks((all) => all.map((w) => (w.id === active ? { ...w, ...change } : w)));
  }
  const [destination, setDestination] = useState<WorkDestination>(null);
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
  // Anchored follow while reading at the bottom; an own send always follows.
  const [ownSendSeq, bumpOwnSend] = useReducer((count: number) => count + 1, 0);
  useChatAutoScroll(history, { activeId: active, messages: work?.messages ?? [], ownSendSeq });
  // Deep-link landing (pending request, delivery or newest message) on open.
  useWorkDestinationScroll(history, {
    destination,
    active,
    spaceOpen: Boolean(space),
    requestStatus: work?.request?.status,
    phase: work?.phase,
  });
  function create(
    index: number,
    text?: string,
    attachments: File[] = [],
    projectId?: string,
    override?: (typeof scenarios)[number],
  ) {
    if (engine.backend === "engine") {
      if (engine.gateError) {
        setNotice("App locale non pronta: impossibile creare il lavoro.");
        return;
      }
      const s = override || scenarios[index]!;
      // Never reuse demo scenario titles as identity — objective text is the work title.
      const title = (text || s.initial || s.title).trim().slice(0, 100) || "Lavoro motore";
      const objective = (text || s.initial).trim() || title;
      void engine.createWork(title, objective).then((created) => {
        if (created) {
          open(created.id);
          setNotice(`Lavoro creato · ${created.id}`);
        }
      });
      return;
    }
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
        scenarioForWork(previous, scenarios).agent === step.agent
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
    if (isEngineBackedWork(work)) {
      setNotice("Avvio piano: non ancora collegato al motore (arriva con F3).");
      return;
    }
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
    if (isEngineBackedWork(work)) {
      setNotice("Consegna simulata non disponibile per questo lavoro.");
      return;
    }
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
  const { simulateQuestion, simulate, runRoutine } = createSimulationActions({
    work, scenario, works, scenarios, viewer, spaceData,
    patch, setNotice, setWorks, setScenarios, open,
  });
  function startAssignment(name: string) {
    open(null);
    setAssignee(name);
  }
  function moveConversation(id: string, projectId: string) {
    if (engine.backend === "engine") {
      setNotice("Spostamento progetto: non ancora collegato al motore.");
      return;
    }
    if (projectId && !spaceData.projects.some((p) => p.id === projectId)) return;
    setWorks((current) => current.map((w) => (w.id === id ? { ...w, projectId } : w)));
  }
  function conversationActions(w: Work) {
    if (isEngineBackedWork(w)) {
      return (
        <ConversationActions
          title={w.title}
          projects={[]}
          current=""
          onRename={() =>
            setNotice("Rinomina non ancora disponibile.")
          }
          onMove={() => setNotice("Spostamento progetto non ancora disponibile.")}
          onCreate={() => setNotice("Promozione a progetto non ancora collegata al motore.")}
          onRepeat={() => setNotice("Automazioni motore: non in questo slice.")}
        />
      );
    }
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
    if (engine.backend === "engine") {
      void engine.createWork("Nuova richiesta", text).then((created) => {
        if (created) {
          open(created.id);
          setNotice(`Lavoro creato per ${name} · ${created.id}`);
        }
      });
      return undefined;
    }
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
    const navigation = !attachments.length ? parseConversationNavigation(text) : null;
    if (navigation) {
      if (navigation.target === "settings") setSettings(true);
      else openSpace(navigation.view);
      return;
    }

    if (engine.backend === "engine") {
      if (engine.gateError || attachments.length) {
        setNotice(engine.gateError ? "App locale non pronta: impossibile salvare." : "Per il confronto usa i due campi file nella scheda Confronta due listini della conversazione. Gli allegati non sono stati inviati.");
        return;
      }
      // One turn at a time, said out loud: a second send would silently abort
      // the turn in flight (single-flight engine contract).
      if (engine.busy) {
        setNotice(
          "Homun sta ancora completando il turno precedente: attendi la risposta oppure premi Annulla.",
        );
        return;
      }
      if (work && isEngineBackedWork(work)) {
        bumpOwnSend();
        void engine
          .postMessage(work, text)
          .then(() => setNotice(""))
          .catch(() => setNotice("Invio al motore non riuscito. Controlla il banner errori."));
        return;
      }
      // First message of a new work: open immediately, then postMessage routes it.
      sendEngineFirstMessage(engine, text, open, setNotice, bumpOwnSend);
      return;
    }

    if (work?.catalogPlan && work.phase !== "approved" && /^sposta\s/i.test(text)) {
      const reorder = parsePlanReorder(text);
      const plan = work.catalogPlan;
      if (reorder) {
        const from = plan.steps.findIndex((s) =>
          s.title.toLowerCase().includes(reorder.itemTitle.toLowerCase()),
        );
        const target = plan.steps.findIndex((s) =>
          s.title.toLowerCase().includes(reorder.anchorTitle.toLowerCase()),
        );
        if (from >= plan.completed && target >= plan.completed && from !== target) {
          const steps = plan.steps.filter((_, i) => i !== from);
          const to =
            steps.findIndex((s) => s.id === plan.steps[target]!.id) +
            (reorder.relation === "dopo" ? 1 : 0);
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
      const insert = parsePlanInsert(text);
      if (insert) {
        const names = [...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])];
        const agent = names.find((n) => text.toLowerCase().includes("@" + n.toLowerCase())) || "";
        const title = stripTrailingMention(insert.rawTitle);
        const anchor = insert.rawAnchor ? stripTrailingMention(insert.rawAnchor).toLowerCase() : "";
        const index = anchor
          ? work.catalogPlan.steps.findIndex((s) => s.title.toLowerCase().includes(anchor))
          : work.catalogPlan.steps.length;
        const position = index + (insert.relation === "dopo" ? 1 : 0);
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
  const library = buildMaterialLibrary(
    materials,
    works,
    attachmentIds.current,
    materialDates.current,
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
    const blocked = validateBoardMove({
      target,
      phase,
      viewer,
      scenarios,
      removedPeople: spaceData.removedPeople,
      profiles: spaceData.profiles,
    });
    if (blocked) return blocked;
    if (phase === "review")
      setSeenResults((current) => current.filter((key) => !key.endsWith(`:${id}`)));
    setWorks((current) =>
      current.map((w) =>
        w.id === id ? applyBoardMove(w, phase as Phase, viewer) : w,
      ),
    );
    return boardMoveSuccessMessage(phase);
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
    if (engine.backend === "engine" && work.source === "engine") {
      void engine.fulfillContribution(work, text, attachments, ids).catch(() => undefined);
      return;
    }
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
            name !== scenarioForWork(work, scenarios).agent &&
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
  const entries = buildConversationSearchEntries({
    library,
    visibleWorks,
    scenarios,
    spaceData: displaySpaceData,
    workStatus,
    openSpace,
    openWork: open,
    openResultPreview: (w) =>
      openWorkResultPreview(w, scenarios, spaceData.profiles, open, setPreview),
  });
  function download() {
    if (!scenario || !work) return;
    downloadWorkResult({ scenario, work });
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
            works: visibleWorks.filter((w) => !w.coordinatedBy).length,
            projects: displaySpaceData.projects.length,
            materials: engine.backend === "engine" ? null : library.length,
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
          onExport={() =>
            downloadPrototypeExport({
              preferences,
              spaceData,
              works,
              materials: library,
            })
          }
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
      <ConversationWorkspaceSidebar engineAgents={engine.backend === "engine" ? engine.agents : undefined}
        sidebarOpen={sidebarOpen}
        searchShortcut={searchShortcut}
        onSearchOpen={() => setSearchOpen(true)}
        onCloseSidebar={() => setSidebarOpen(false)}
        onNewConversation={() => open(null)}
        space={space}
        onOpenSpace={openSpace}
        spaceData={displaySpaceData}
        libraryCount={engine.backend === "engine" ? null : library.length}
        visibleWorks={visibleWorks}
        works={engine.backend === "engine" ? engine.works : works}
        scenarios={scenarios}
        active={active}
        onOpenWork={open}
        onMoveConversation={moveConversation}
        conversationActions={conversationActions}
        workStatus={workStatus}
        workListOpen={workListOpen}
        onToggleWorkList={() => setWorkListOpen(!workListOpen)}
        squadListOpen={squadListOpen}
        onToggleSquadList={() => setSquadListOpen(!squadListOpen)}
        preferences={preferences}
        onOpenSettings={() => setSettings(true)}
      />
      <main className={`cw-main ${panel ? "" : "cw-details-hidden"}`}>
        <ConversationWorkspaceTopbar
          engineMode={engine.backend === "engine"}
          sidebarOpen={sidebarOpen}
          onOpenSidebar={() => setSidebarOpen(true)}
          space={space}
          work={work}
          preferences={preferences}
          onOpenSettings={() => setSettings(true)}
          viewer={viewer}
          onViewerChange={(next) => {
            setViewer(next);
            setNotifications(false);
          }}
          spaceData={displaySpaceData}
          notificationCount={notificationCount}
          notificationsOpen={notifications}
          onToggleNotifications={() => setNotifications(!notifications)}
          onCloseNotifications={() => setNotifications(false)}
          pending={pending}
          completedNotices={completedNotices}
          scenarios={scenarios}
          onOpenWork={open}
          showPanelToggle={!!(work || space)}
          panelOpen={panel}
          onTogglePanel={() => setPanel(!panel)}
        />
        {/* Engine diagnostics live in Settings, not above the conversation.
            Errors that block work surface through HomunErrorNotice. */}
        {space ? (
          <ConversationWorkspaceSpaceHost engineAgents={engine.backend === "engine" ? engine.agents : undefined}
            engineMode={engine.backend === "engine"} onRefreshEngine={engine.backend === "engine" ? engine.refresh : undefined}
            space={space}
            spaceInitial={spaceInitial}
            spaceSelected={spaceSelected}
            spaceVersion={spaceVersion}
            spaceData={displaySpaceData}
            setSpaceData={setSpaceData}
            scenarios={scenarios}
            setScenarios={setScenarios}
            works={engine.backend === "engine" ? engine.works : works}
            setWorks={setWorks}
            setMaterials={setMaterials}
            visibleWorks={visibleWorks}
            library={library}
            active={active}
            viewer={viewer}
            setViewer={setViewer}
            pending={pending}
            workStatus={workStatus}
            onRevealPanel={() => setPanel(true)}
            onOpenSpace={openSpace}
            onOpenWork={open}
            onMoveWork={moveWork}
            onStartAssignment={startAssignment}
            onCreateFreeWork={createFreeWork}
            onRunRoutine={runRoutine}
            onUpdateMaterial={updateMaterial}
            onRemoveMaterial={removeMaterial}
            onLinkMaterial={linkMaterial}
          />
        ) : work && scenario && isHumanMember(scenario.agent, spaceData.profiles) && !isEngineBackedWork(work) ? (
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
          <ConversationWorkspaceChatStage
            work={work}
            scenario={scenario}
            panelOpen={panel}
            spaceData={displaySpaceData}
            scenarios={scenarios}
            assignee={assignee}
            active={active}
            viewer={viewer}
            notice={notice}
            storageStatus={storageStatus}
            planEdit={planEdit}
            contributionPanel={contributionPanel}
            conversationActions={conversationActions}
            historyRef={history}
            onCreateExample={create}
            onOpenWork={open}
            onPreview={() => setPreview(true)}
            onApprovePlan={approvePlan}
            onApplyPlanEdit={(plan) => updatePlan(plan)}
            onCancelPlanEdit={() => setPlanEdit(null)}
            onSend={send}
            onClearNotice={() => setNotice("")}
            engineMode={engine.backend === "engine"} engineIntake={engine.intake} onRefreshEngine={engine.refresh}
            engineAgents={engine.backend === "engine" ? engine.agents : undefined}
            engineBusy={engine.busy}
            historyLoading={engine.historyLoading}
            onConfirmPatch={(messageIndex) => {
              if (!work) return;
              void engine.confirmPatch(work, messageIndex).catch(() => {
                setNotice("Applicazione patch non riuscita. Controlla il banner errori.");
              });
            }}
            onDiscardPatch={(messageIndex) => {
              if (!work) return;
              engine.discardPatch(work, messageIndex);
            }}
            onSaveMemory={(messageIndex) => {
              if (!work) return;
              void engine.saveMemoryFromMessage(work, messageIndex).catch(() => {
                setNotice("Salvataggio memoria non riuscito. Controlla il banner errori.");
              });
            }}
            onCancelInFlight={() => engine.cancelInFlight()}
            details={
              work && scenario ? (
                <ConversationWorkspaceWorkPanel
                  work={work}
                  scenario={scenario}
                  viewer={viewer}
                  spaceData={displaySpaceData}
                  preferences={preferences}
                  library={library}
                  contribution={contribution}
                  files={files}
                  contributionPanel={contributionPanel}
                  workStatus={workStatus}
                  onPatch={patch}
                  onUpdatePlan={updatePlan}
                  onOpenSpace={openSpace}
                  onOpenWork={open}
                  onConfirm={confirm}
                  onDeliver={() => deliver()}
                  onSimulate={simulate}
                  onSimulateQuestion={simulateQuestion}
                  onContributionChange={setContribution}
                  onFilesChange={setFiles}
                  onPreview={() => setPreview(true)}
                  engineBusy={engine.busy} onRename={work.source === "engine" ? (title) => engine.renameWork(work, title) : undefined}
                  engineIntake={engine.intake} onCloseWork={work.source === "engine" ? () => engine.closeWork(work) : undefined}
                  onStartWork={work.source === "engine" ? () => engine.startWork(work) : undefined} onSubmitArtifact={work.source === "engine" ? (title, content) => engine.submitArtifact(work, title, content) : undefined}
                  agentNames={Object.fromEntries(engine.agents.map((agent) => [agent.id, agent.name]))}
                  {...(work.source === "engine"
                    ? {
                        onApplyObjectivePatch: (next: string) =>
                          engine.applyObjectivePatch(work, next).catch((cause) => {
                            setNotice("Aggiornamento obiettivo non riuscito."); throw cause;
                          }),
                      }
                    : {})}
                  onRegisterAgent={(name, role) => {
                    const result = registerPlanAgent(name, role, spaceData);
                    if (!result.ok) return false;
                    setScenarios((current) => [...current, result.scenario]);
                    setSpaceData((current) => ({
                      ...current,
                      profiles: { ...current.profiles, [name]: result.profile },
                    }));
                    return true;
                  }}
                  uploadRef={upload}
                  directoryRef={directory}
                />
              ) : null
            }
          />
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
        <ConversationWorkspacePreview
          work={work}
          scenario={scenario}
          modalRef={modal}
          onClose={() => setPreview(false)}
          onDownload={download}
        />
      )}
    </div>
  );
}
