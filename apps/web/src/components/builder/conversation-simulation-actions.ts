/** Simulation-only progression and routine runs; never applies engine mutations. */
import type { Dispatch, SetStateAction } from "react";
import type { Work } from "./conversation-types";
import type { SpaceData, SpaceRoutine } from "./ConversationSpace";
import { initialScenarios, scenarioForWork, type ConversationScenario } from "./conversation-scenarios";
import { isHumanMember, memberProfile } from "./conversation-members";
import { isEngineBackedWork } from "@/lib/conversation-engine-bridge";

type StateSetter<T> = Dispatch<SetStateAction<T>>;
type Context = {
  work: Work | undefined;
  scenario: ConversationScenario | null;
  works: Work[];
  scenarios: ConversationScenario[];
  viewer: string;
  spaceData: SpaceData;
  patch: (change: Partial<Work>) => void;
  setNotice: (message: string) => void;
  setWorks: StateSetter<Work[]>;
  setScenarios: StateSetter<ConversationScenario[]>;
  open: (id: string | null) => void;
};

export function createSimulationActions({ work, scenario, works, scenarios, viewer, spaceData,
  patch, setNotice, setWorks, setScenarios, open }: Context) {
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
    if (isEngineBackedWork(work)) {
      setNotice("Simulazione disabilitata: questo lavoro è sul motore.");
      return;
    }
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
  function runRoutine(r: SpaceRoutine) {
    const source = works.find((w) => w.id === r.workId);
    if (
      !source ||
      !r.active ||
      source.archived ||
      spaceData.removedPeople?.includes(scenarioForWork(source, scenarios).agent)
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
    const sourceChrome = scenarioForWork(source, scenarios);
    const human = isHumanMember(sourceChrome.agent, spaceData.profiles);
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
        need: sourceChrome.input + ". " + sourceChrome.help,
        status: "pending",
      };
    setWorks((current) => [...current, run, ...children]);
    open(id);
  }
  return { simulateQuestion, simulate, runRoutine };
}
