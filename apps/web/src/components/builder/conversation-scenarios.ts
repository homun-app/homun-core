/**
 * Demo scenario catalog for the simulated conversation workspace.
 * Keep this data out of ConversationWorkspace so the shell stays composition-only.
 */

export type ConversationScenario = {
  title: string;
  agent: string;
  initial: string;
  role: string;
  color: string;
  icon: string;
  input: string;
  help: string;
  outcome: string;
  steps: string[];
  result: string;
  body: string;
  custom?: boolean;
};

export const initialScenarios: ConversationScenario[] = [
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

export const phaseText: Record<
  "proposal" | "waiting" | "ready" | "review" | "approved",
  string
> = {
  proposal: "Da concordare",
  waiting: "Serve il tuo contributo",
  ready: "Pronto a partire",
  review: "Da verificare",
  approved: "Approvato",
};

/** Chrome for Fonte=motore works — never reuse Marta/Vera demo scenarios. */
export const engineHomunScenario: ConversationScenario = {
  title: "Lavoro sul motore",
  agent: "Homun",
  initial: "",
  role: "Motore locale",
  color: "sage",
  icon: "H",
  input: "Obiettivo e vincoli del lavoro",
  help: "Descrivi cosa vuoi ottenere. Homun interpreta e propone piano o modifiche.",
  outcome: "Un lavoro versionato sul dominio SQLite del motore.",
  steps: [],
  result: "",
  body: "",
};

/** Resolve display chrome: engine works always Homun, never demo agent by scenario index.
 * Prefer this helper everywhere (sidebar, chat, search, status) — do not read
 * `scenarios[work.scenario]` for UI when `source` may be `"engine"`.
 */
export function scenarioForWork(
  work: { source?: "simulation" | "engine"; scenario: number },
  scenarios: ConversationScenario[],
): ConversationScenario {
  if (work.source === "engine") {
    return engineHomunScenario;
  }
  const found = scenarios[work.scenario];
  if (!found) {
    return engineHomunScenario;
  }
  return found;
}
