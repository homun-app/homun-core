import { emptyFirstWorkDraft, type FirstWorkDraft } from "./first-work.ts";

export type Example = {
  id: string;
  label: string;
  need: string;
  name: string;
  responsibility: string;
  title: string;
  outcome: string;
  frequency: string;
  method: string;
  tools: string[];
  requestLabel: string;
  referenceLabel: string;
  request: string;
  reference: string;
  resultTitle: string;
  result: string;
  checks: string[];
};

export const WORK_EXAMPLES: Example[] = [
  {
    id: "requests",
    label: "Seguire i preventivi",
    need: "Ogni mattina controlla le richieste di preventivo, prepara le risposte con il nostro listino e avvisami quando manca qualcosa.",
    name: "Marta",
    responsibility: "Segue le richieste dei clienti e prepara i preventivi da rivedere.",
    title: "Preparare la risposta alla prima richiesta",
    outcome: "Una bozza con importi dal listino e le eventuali informazioni mancanti.",
    frequency: "Ogni mattina",
    tools: ["files", "email"],
    method:
      "Leggere la richiesta e individuare i dati mancanti\nConsultare il listino per le voci richieste\nPreparare la bozza e controllare gli importi\nChiedere conferma prima di inviare",
    requestLabel: "Una richiesta del cliente",
    referenceLabel: "Il listino di riferimento",
    request:
      "Buongiorno, vorrei un preventivo per la manutenzione ordinaria di due climatizzatori. Sono Luca Rossi. Grazie.",
    reference:
      "Listino di esempio: manutenzione ordinaria climatizzatore, 80 € per unità, IVA inclusa. Trasferta esclusa: da valutare in base all’indirizzo.",
    resultTitle: "La bozza è pronta. Manca l’indirizzo.",
    result:
      "Buongiorno Luca, per la manutenzione ordinaria di due climatizzatori l’importo è di 160 € IVA inclusa. Per completare il preventivo con l’eventuale trasferta, può indicarci l’indirizzo dell’intervento? Grazie.",
    checks: [
      "2 interventi × 80 € = 160 € IVA inclusa",
      "Trasferta esclusa e segnalata",
      "Richiesta dell’indirizzo inserita nella bozza",
    ],
  },
  {
    id: "news",
    label: "Preparare una rassegna",
    need: "Ogni lunedì prepara una breve rassegna delle novità del settore, con le fonti e le cose da approfondire.",
    name: "Vera",
    responsibility: "Raccoglie le novità rilevanti e prepara una rassegna documentata.",
    title: "Preparare la prima rassegna",
    outcome: "Un riepilogo leggibile con fonti, date e temi da approfondire.",
    frequency: "Ogni lunedì",
    tools: ["web", "files"],
    method:
      "Raccogliere le notizie dalle fonti indicate\nControllare date, rilevanza e duplicati\nDistinguere i fatti dalle interpretazioni\nPreparare il riepilogo con i riferimenti",
    requestLabel: "Il tema da seguire",
    referenceLabel: "Le fonti di partenza",
    request:
      "Segui le novità dei componenti industriali. Evidenzia impatti su manutenzione e disponibilità.",
    reference:
      "Materiale fittizio per la demo. Bollettino A, 14 settembre: nuova pompa con intervallo di manutenzione dichiarato di 12 mesi. Bollettino B, 15 settembre: consegne della serie X posticipate di due settimane.",
    resultTitle: "Due novità da tenere presenti.",
    result:
      "• Manutenzione: il Bollettino A del 14 settembre annuncia una pompa con intervallo dichiarato di 12 mesi. Da verificare nelle specifiche tecniche.\n\n• Disponibilità: il Bollettino B del 15 settembre segnala due settimane di ritardo per la serie X. Da confrontare con gli ordini aperti.",
    checks: [
      "Entrambe le fonti e le date riportate",
      "Nessuna visita web effettuata: fonti fittizie della demo",
      "Approfondimenti distinti dai fatti riportati",
    ],
  },
  {
    id: "service",
    label: "Controllare un servizio",
    need: "Controlla ogni giorno i log del servizio, individua gli errori e prepara una correzione da verificare prima del rilascio.",
    name: "Elio",
    responsibility: "Controlla il servizio e prepara interventi documentati per la revisione.",
    title: "Analizzare il primo errore",
    outcome: "Una diagnosi con evidenze e un piano di correzione verificabile.",
    frequency: "Ogni giorno",
    tools: ["terminal", "files"],
    method:
      "Raccogliere i log del servizio interessato\nRiprodurre l’errore nel progetto locale\nPreparare la correzione e verificarla con un test\nPresentare le modifiche prima del rilascio",
    requestLabel: "L’errore da analizzare",
    referenceLabel: "Le informazioni del servizio",
    request: "Esempio: il processo non parte. Log: CONFIG_ERROR: REPORT_DIR is required.",
    reference:
      "Servizio report-worker. Configurazione di esempio: REPORT_DIR non è definita. La cartella di destinazione prevista è /data/reports. Nessun accesso al server in questa demo.",
    resultTitle: "Configurazione incompleta: verifica proposta.",
    result:
      "Il log segnala REPORT_DIR assente e la configurazione fornita lo conferma. Proposta: impostare REPORT_DIR=/data/reports, controllare che la cartella sia accessibile al processo e verificare l’avvio in ambiente di prova. Nessuna modifica o verifica del servizio è stata eseguita.",
    checks: [
      "Diagnosi collegata al messaggio del log",
      "Percorso ricavato dalle informazioni fornite",
      "Correzione e test ancora da eseguire",
    ],
  },
];

export type AssistedDraft = FirstWorkDraft & { exampleId: string | null; frequency: string };

export function createProposal(need: string, exampleId: string | null): AssistedDraft {
  const example = WORK_EXAMPLES.find((item) => item.id === exampleId);
  return {
    ...emptyFirstWorkDraft(),
    need,
    exampleId: example?.id ?? null,
    name: example?.name ?? "Nuovo collaboratore",
    responsibility: example?.responsibility ?? need.trim(),
    title: example?.title ?? "Prima prova",
    outcome: example?.outcome ?? need.trim(),
    frequency: example?.frequency ?? "Su richiesta",
    method: example?.method ?? "",
    tools: example ? [...example.tools] : ["files"],
  };
}

export function exampleFor(draft: AssistedDraft) {
  return WORK_EXAMPLES.find((item) => item.id === draft.exampleId);
}

export function sampleMaterials(draft: AssistedDraft): AssistedDraft {
  const example = exampleFor(draft);
  return example ? { ...draft, context: example.request, knowledge: example.reference } : draft;
}

export function sampleResult(draft: AssistedDraft): Example | null {
  const example = exampleFor(draft);
  if (
    !example ||
    draft.context !== example.request ||
    draft.knowledge !== example.reference ||
    draft.method !== example.method ||
    draft.outcome !== example.outcome ||
    draft.responsibility !== example.responsibility
  )
    return null;
  return example;
}

export function missingMaterials(draft: AssistedDraft): string[] {
  const example = exampleFor(draft);
  return [
    !draft.context.trim() ? (example?.requestLabel ?? "Un caso da cui partire") : null,
    !draft.knowledge.trim() ? (example?.referenceLabel ?? "Materiali di riferimento") : null,
  ].filter((value): value is string => value !== null);
}
