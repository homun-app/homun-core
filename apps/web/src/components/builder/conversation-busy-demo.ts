import type { Work } from "./conversation-types";
export const busyProjects = ["Catalogo autunno", "Espansione Italia", "Qualità del servizio"].map(
  (name, i) => ({
    id: `busy-project-${i}`,
    name,
    teamId: i === 2 ? "busy-team-operations" : "busy-team-commercial",
    brief: "Progetto dimostrativo con lavori in fasi diverse.",
  }),
);
const titles = [
  "Preparare il catalogo autunno",
  "Confrontare i concorrenti",
  "Analizzare gli errori di accesso",
  "Verificare il preventivo Rossi",
  "Rapporto sul mercato italiano",
  "Controllo settimanale dei log",
  "Tradurre le schede prodotto",
  "Ricercare distributori",
  "Verificare il servizio pagamenti",
  "Approvare il listino aggiornato",
  "Sintesi delle fonti",
  "Monitoraggio disponibilità",
  "Preparare la presentazione",
  "Confrontare le offerte",
  "Analizzare i tempi di risposta",
  "Verificare il catalogo inglese",
  "Rapporto sui distributori",
  "Riepilogo operativo",
];
export function busyWorks(): Work[] {
  return titles.map((title, i) => {
    const phase = (["proposal", "ready", "waiting", "review", "approved", "ready"] as const)[
      i % 6
    ]!;
    const agent = ["Marta", "Vera", "Elio"][i % 3]!;
    const completed = phase === "review" || phase === "approved" ? 2 : phase === "ready" ? 1 : 0;
    return {
      id: `busy-work-${i}`,
      title,
      scenario: i % 3,
      projectId: busyProjects[i % 3]!.id,
      phase,
      requester: "Fabio",
      reviewer: "Fabio",
      due: "",
      files: [],
      contribution: phase === "proposal" ? "" : "Indicazioni iniziali della demo",
      revision: 1,
      feedback: "",
      ...(phase === "approved" ? { approvedBy: "Fabio" } : {}),
      ...(i % 6 === 5 ? { routineId: `busy-routine-${i}`, runNumber: 1 } : {}),
      ...(phase === "waiting"
        ? {
            request: {
              to: "Fabio",
              need: "Indica il servizio e l’intervallo di tempo da esaminare, oppure allega i log.",
              status: "pending" as const,
            },
          }
        : {}),
      catalogPlan: {
        completed,
        steps: ["Raccogliere e verificare le informazioni", "Preparare la consegna"].map(
          (step, j) => ({
            id: `busy-step-${i}-${j}`,
            title: step,
            agent,
            ...(j < completed
              ? {
                  result: `Esempio dimostrativo: ${step.toLowerCase()} per «${title}». Nessuna elaborazione reale.`,
                }
              : {}),
          }),
        ),
      },
      messages: [
        { who: "you", text: `Occupati di: ${title}.` },
        ...Array.from({ length: 8 }, (_, j) => ({
          who: "agent" as const,
          sender: agent,
          text: `Aggiornamento dimostrativo ${j + 1}: contesto e indicazioni conservati per ${title.toLowerCase()}.`,
        })),
        {
          who: "agent",
          sender: agent,
          text:
            phase === "waiting"
              ? "Mi serve una tua indicazione per continuare."
              : phase === "review"
                ? "La consegna è pronta per la tua verifica."
                : phase === "approved"
                  ? "Consegna approvata e disponibile."
                  : "Il piano è disponibile qui accanto.",
        },
      ],
    };
  });
}
export const busyRoutines = [5, 11, 17].map((i) => ({
  id: `busy-routine-${i}`,
  name: titles[i]!,
  workId: `busy-work-${i}`,
  schedule: "Ogni lunedì alle 09:00 · Europe/Rome",
  active: true,
}));

export const busyTeams = [
  {
    id: "busy-team-commercial",
    name: "Commerciale",
    members: ["Marta", "Vera", "Fabio"],
    leader: "Marta",
    brief: "Catalogo, clienti e sviluppo commerciale.",
  },
  {
    id: "busy-team-operations",
    name: "Operazioni",
    members: ["Elio", "Giulia", "Fabio"],
    leader: "Elio",
    brief: "Qualità del servizio e analisi operativa.",
  },
];
export function busyMaterials() {
  return [
    "Brief catalogo.txt",
    "Listino dimostrativo.txt",
    "Brief mercato.txt",
    "Fonti da verificare.txt",
    "Log dimostrativi.txt",
    "Procedura di verifica.txt",
  ].map((name, i) => ({
    id: `busy-material-${i}`,
    name,
    addedAt: new Date(Date.now() - i * 86400000).toISOString(),
    projectIds: [`busy-project-${Math.floor(i / 2)}`],
    visibility: "Nei lavori collegati",
    file: new File(
      [
        `MATERIALE DIMOSTRATIVO\n${name}\nContenuti fittizi per provare importazione, collegamenti e download. Nessun dato reale di clienti.\n`,
      ],
      name,
      { type: "text/plain" },
    ),
  }));
}
