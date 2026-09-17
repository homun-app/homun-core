export type MemberProfile = {
  kind?: "agent" | "human";
  email?: string;
  invitation?: "pending" | "accepted";
  role: string;
  bio: string;
  skills: string[];
  tone: string;
  plugins: string[];
};
export const memberDefaults: Record<string, MemberProfile> = {
  Marta: {
    role: "Ufficio e clienti",
    bio: "Prepara documenti, preventivi e risposte alle richieste dei clienti. Organizza i materiali e segnala le informazioni mancanti.",
    skills: ["Preventivi", "Documenti commerciali", "Gestione clienti"],
    tone: "Cordiale, concreta e sintetica.",
    plugins: [],
  },
  Vera: {
    role: "Ricerca e aggiornamenti",
    bio: "Confronta fonti, raccoglie informazioni e prepara sintesi con riferimenti verificabili.",
    skills: ["Ricerca di mercato", "Analisi delle fonti", "Sintesi"],
    tone: "Chiara e analitica. Distingue fatti e ipotesi.",
    plugins: [],
  },
  Elio: {
    role: "Operazioni e qualità",
    bio: "Analizza log e task, collega il contesto aziendale e propone priorità e piani di lavoro.",
    skills: ["Analisi dei log", "Pianificazione", "Controllo qualità"],
    tone: "Diretto e preciso.",
    plugins: [],
  },
  Giulia: {
    kind: "human",
    role: "Collaboratrice",
    bio: "Collabora alla preparazione e alla revisione dei materiali aziendali.",
    skills: ["Revisione documenti"],
    tone: "",
    plugins: [],
  },
  Fabio: {
    kind: "human",
    role: "Responsabile",
    bio: "Definisce gli obiettivi e verifica i risultati della squadra.",
    skills: ["Coordinamento", "Revisione"],
    tone: "",
    plugins: [],
  },
};
export type CatalogPlugin = {
  name: string;
  description: string;
  source: "Composio" | "MCP" | "Skill" | "Aziendale";
  category: "Produttività" | "Comunicazione" | "Conoscenza" | "Dati e file" | "Sviluppo";
};
// Illustrative catalog entries: sources describe the proposed integration, not a live connector.
export const memberPluginCatalog: CatalogPlugin[] = [
  {
    name: "Trello",
    description: "Schede, assegnazioni e avanzamento del lavoro",
    source: "Composio",
    category: "Produttività",
  },
  {
    name: "Mattermost",
    description: "Conversazioni e contesto della squadra",
    source: "Aziendale",
    category: "Comunicazione",
  },
  {
    name: "Wiki",
    description: "Procedure e conoscenza aziendale",
    source: "MCP",
    category: "Conoscenza",
  },
  {
    name: "Email",
    description: "Messaggi e richieste dei clienti",
    source: "Composio",
    category: "Comunicazione",
  },
  {
    name: "Cartelle locali",
    description: "File e documenti selezionati",
    source: "MCP",
    category: "Dati e file",
  },
  {
    name: "Calendario",
    description: "Appuntamenti e disponibilità della squadra",
    source: "Composio",
    category: "Produttività",
  },
  {
    name: "Database",
    description: "Consulta dati da una sorgente configurata",
    source: "MCP",
    category: "Dati e file",
  },
  {
    name: "Repository",
    description: "Codice, modifiche e documentazione tecnica",
    source: "MCP",
    category: "Sviluppo",
  },
  {
    name: "Revisione documenti",
    description: "Metodo di controllo per chiarezza, completezza e coerenza",
    source: "Skill",
    category: "Conoscenza",
  },
  {
    name: "Analisi dei log",
    description: "Procedura per riconoscere errori e preparare una diagnosi",
    source: "Skill",
    category: "Sviluppo",
  },
  {
    name: "Preventivi",
    description: "Modelli e regole commerciali della tua azienda",
    source: "Aziendale",
    category: "Produttività",
  },
  {
    name: "Gestionale interno",
    description: "Collegamento personalizzato a prodotti e ordini",
    source: "Aziendale",
    category: "Dati e file",
  },
];
export function memberProfile(name: string, profiles?: Record<string, MemberProfile>) {
  return (
    profiles?.[name] ||
    memberDefaults[name] || { role: "Collaboratore", bio: "", skills: [], tone: "", plugins: [] }
  );
}

export function isHumanMember(name: string, profiles?: Record<string, MemberProfile>) {
  return memberProfile(name, profiles).kind === "human";
}
