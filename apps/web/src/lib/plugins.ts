/**
 * Registro plugin di Homun.
 *
 * Il core (chat, pipeline, dashboard) non conosce nessun servizio specifico:
 * legge tutto da questo registro. Aggiungere una capacità = aggiungere un plugin.
 */

export type FieldDef = {
  key: string;
  label: string;
  placeholder?: string;
  type?: "text" | "textarea" | "number" | "url" | "email";
  required?: boolean;
};

export type PluginTool = {
  key: string;
  name: string;
  description: string;
};

export type PluginTrigger = {
  key: string;
  /** Frase leggibile: "Quando arriva una nuova email" */
  label: string;
  fields?: FieldDef[];
};

export type PluginAction = {
  key: string;
  /** Frase leggibile: "Invia una email" */
  label: string;
  fields?: FieldDef[];
};

export type PluginWidget = {
  key: string;
  title: string;
  description: string;
};

export type Plugin = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  /** Nome icona lucide-react */
  icon: string;
  category: "Comunicazione" | "Amministrazione" | "Mercato" | "Organizzazione";
  needsConnection: boolean;
  connectionLabel?: string;
  connectionFields?: FieldDef[];
  tools: PluginTool[];
  triggers: PluginTrigger[];
  actions: PluginAction[];
  widgets: PluginWidget[];
};

export const PLUGINS: Plugin[] = [
  {
    id: "email",
    name: "Email",
    tagline: "Leggi e rispondi ai messaggi della casella aziendale",
    description:
      "Il bot legge la posta in arrivo, prepara le risposte e può inviarle da solo o solo dopo la tua approvazione.",
    icon: "Mail",
    category: "Comunicazione",
    needsConnection: true,
    connectionLabel: "Collega una casella email",
    connectionFields: [
      { key: "address", label: "Indirizzo email", type: "email", required: true, placeholder: "info@laziendamia.it" },
      { key: "signature", label: "Firma da usare nelle risposte", type: "textarea", placeholder: "Cordiali saluti,\nMario" },
    ],
    tools: [
      { key: "leggi_email", name: "Leggi le email recenti", description: "Elenca i messaggi più recenti della casella collegata." },
      { key: "prepara_risposta", name: "Prepara una risposta", description: "Scrive una risposta a un messaggio ricevuto." },
      { key: "invia_email", name: "Invia una email", description: "Invia un messaggio a un destinatario." },
    ],
    triggers: [
      {
        key: "nuova_email",
        label: "Quando arriva una nuova email",
        fields: [{ key: "filtro", label: "Solo se il messaggio contiene", placeholder: "preventivo" }],
      },
      { key: "email_senza_risposta", label: "Quando una email resta senza risposta da 2 giorni" },
    ],
    actions: [
      {
        key: "invia_email",
        label: "Invia una email",
        fields: [
          { key: "destinatario", label: "A chi", type: "email", required: true },
          { key: "oggetto", label: "Oggetto", required: true },
          { key: "testo", label: "Testo del messaggio", type: "textarea", required: true },
        ],
      },
      { key: "bozza_risposta", label: "Prepara una bozza di risposta e avvisami" },
    ],
    widgets: [
      { key: "email_da_gestire", title: "Email da gestire", description: "Messaggi in attesa di una risposta." },
      { key: "email_risposte_oggi", title: "Risposte inviate oggi", description: "Quante risposte ha gestito il bot." },
    ],
  },
  {
    id: "calendario",
    name: "Calendario",
    tagline: "Appuntamenti, disponibilità e promemoria",
    description: "Il bot controlla gli impegni, propone orari liberi e fissa gli appuntamenti al posto tuo.",
    icon: "CalendarDays",
    category: "Organizzazione",
    needsConnection: true,
    connectionLabel: "Collega un calendario",
    connectionFields: [
      { key: "calendario", label: "Nome del calendario", required: true, placeholder: "Appuntamenti clienti" },
      { key: "orari", label: "Orari in cui si può fissare", placeholder: "Lun-Ven 9:00-18:00" },
    ],
    tools: [
      { key: "leggi_agenda", name: "Guarda l'agenda", description: "Elenca gli impegni di un giorno o di una settimana." },
      { key: "trova_orario", name: "Trova un orario libero", description: "Propone gli orari disponibili." },
      { key: "fissa_appuntamento", name: "Fissa un appuntamento", description: "Aggiunge un impegno in calendario." },
    ],
    triggers: [
      { key: "appuntamento_domani", label: "Il giorno prima di un appuntamento" },
      { key: "nuova_richiesta", label: "Quando qualcuno chiede un appuntamento" },
    ],
    actions: [
      {
        key: "crea_evento",
        label: "Fissa un appuntamento",
        fields: [
          { key: "titolo", label: "Titolo", required: true },
          { key: "durata", label: "Durata in minuti", type: "number", placeholder: "30" },
        ],
      },
      { key: "invia_promemoria", label: "Invia un promemoria al cliente" },
    ],
    widgets: [
      { key: "agenda_oggi", title: "Agenda di oggi", description: "Gli impegni delle prossime ore." },
    ],
  },
  {
    id: "fatture",
    name: "Fatture e solleciti",
    tagline: "Tieni sotto controllo gli incassi e ricorda i pagamenti",
    description:
      "Registri le fatture emesse: il bot vede quali sono scadute e manda i solleciti con il tono che scegli tu.",
    icon: "ReceiptEuro",
    category: "Amministrazione",
    needsConnection: true,
    connectionLabel: "Imposta i solleciti",
    connectionFields: [
      { key: "giorni", label: "Giorni di ritardo prima del primo sollecito", type: "number", placeholder: "7" },
      { key: "tono", label: "Tono del sollecito", placeholder: "gentile ma fermo" },
    ],
    tools: [
      { key: "fatture_scadute", name: "Elenca le fatture scadute", description: "Mostra chi non ha ancora pagato." },
      { key: "prepara_sollecito", name: "Prepara un sollecito", description: "Scrive il messaggio di sollecito per un cliente." },
    ],
    triggers: [
      {
        key: "fattura_scaduta",
        label: "Quando una fattura supera la scadenza",
        fields: [{ key: "giorni", label: "Dopo quanti giorni di ritardo", type: "number", placeholder: "7" }],
      },
    ],
    actions: [
      { key: "invia_sollecito", label: "Invia il sollecito al cliente" },
      { key: "avvisa_team", label: "Avvisa il team dell'insoluto" },
    ],
    widgets: [
      { key: "insoluti", title: "Fatture da incassare", description: "Totale e numero di fatture scadute." },
    ],
  },
  {
    id: "monitoraggio",
    name: "Monitoraggio siti",
    tagline: "Sai subito quando una pagina che ti interessa cambia",
    description: "Controlla le pagine che indichi e ti avvisa quando cambiano prezzi, testi o annunci.",
    icon: "Radar",
    category: "Mercato",
    needsConnection: false,
    tools: [
      { key: "controlla_pagina", name: "Controlla una pagina", description: "Legge una pagina web e riassume cosa contiene." },
      { key: "elenca_cambiamenti", name: "Elenca i cambiamenti", description: "Mostra le variazioni rilevate di recente." },
    ],
    triggers: [
      {
        key: "pagina_cambiata",
        label: "Quando una pagina cambia",
        fields: [{ key: "url", label: "Indirizzo della pagina", type: "url", required: true, placeholder: "https://..." }],
      },
    ],
    actions: [{ key: "salva_rilevazione", label: "Salva il cambiamento nel diario del progetto" }],
    widgets: [
      { key: "cambiamenti_recenti", title: "Cambiamenti rilevati", description: "Le ultime variazioni sulle pagine seguite." },
    ],
  },
  {
    id: "concorrenti",
    name: "Analisi concorrenti",
    tagline: "Un report periodico su cosa fanno gli altri",
    description:
      "Indichi i concorrenti: il bot osserva i loro siti, confronta offerte e prezzi e prepara un riassunto ogni settimana.",
    icon: "Telescope",
    category: "Mercato",
    needsConnection: false,
    tools: [
      { key: "elenca_concorrenti", name: "Elenca i concorrenti seguiti", description: "Mostra i concorrenti del progetto." },
      { key: "aggiungi_concorrente", name: "Aggiungi un concorrente", description: "Inizia a seguire un nuovo concorrente." },
      { key: "confronta", name: "Confronta con i concorrenti", description: "Riassume differenze di offerta e posizionamento." },
    ],
    triggers: [{ key: "report_settimanale", label: "Ogni settimana, il lunedì mattina" }],
    actions: [
      { key: "genera_report", label: "Prepara il report sui concorrenti" },
      { key: "avvisa_email", label: "Mandami il report per email" },
    ],
    widgets: [
      { key: "concorrenti_seguiti", title: "Concorrenti seguiti", description: "Chi stai osservando e da quando." },
      { key: "ultimo_report", title: "Ultimo report concorrenti", description: "Il riassunto più recente." },
    ],
  },
];

/** Riquadri del core: sempre disponibili, non arrivano da un plugin. */
export const CORE_WIDGETS: PluginWidget[] = [
  { key: "bots_attivi", title: "Bot e agenti attivi", description: "Chi sta lavorando in questo progetto." },
  { key: "pipeline_in_corso", title: "Pipeline in esecuzione", description: "Automazioni attive e ultimi esiti." },
  { key: "attivita_recente", title: "Attività recente", description: "Cosa è stato fatto nelle ultime ore." },
];

export function getPlugin(id: string): Plugin | undefined {
  return PLUGINS.find((p) => p.id === id);
}

export function pluginLabel(id: string): string {
  return getPlugin(id)?.name ?? id;
}

export function triggerLabel(pluginId: string | null, key: string | null): string {
  if (!pluginId || !key) return "Scegli quando partire";
  return getPlugin(pluginId)?.triggers.find((t) => t.key === key)?.label ?? key;
}

export function actionLabel(pluginId: string, key: string): string {
  return getPlugin(pluginId)?.actions.find((a) => a.key === key)?.label ?? key;
}

/** Tutti i riquadri disponibili dato l'insieme dei plugin installati. */
export function availableWidgets(installedPluginIds: string[]) {
  const fromPlugins = PLUGINS.filter((p) => installedPluginIds.includes(p.id)).flatMap((p) =>
    p.widgets.map((w) => ({ ...w, pluginId: p.id, pluginName: p.name, icon: p.icon }))
  );
  return [
    ...CORE_WIDGETS.map((w) => ({ ...w, pluginId: "core", pluginName: "Homun", icon: "LayoutGrid" })),
    ...fromPlugins,
  ];
}
