/**
 * Modello condiviso per la creazione guidata (conversazione) e la mappa visiva.
 * Nessuna logica di rete: solo forma dei dati e frasi leggibili in italiano.
 */

import { PLUGINS, getPlugin } from "@/lib/plugins";

export type StepDraft = {
  pluginId: string;
  actionKey: string;
  config: Record<string, string>;
};

export type AutomationDraft = {
  name: string;
  triggerPluginId: string;
  triggerKey: string;
  triggerConfig: Record<string, string>;
  steps: StepDraft[];
};

export const emptyDraft: AutomationDraft = {
  name: "",
  triggerPluginId: "",
  triggerKey: "",
  triggerConfig: {},
  steps: [],
};

export type TriggerOption = {
  pluginId: string;
  pluginName: string;
  key: string;
  label: string;
};

export type ActionOption = {
  pluginId: string;
  pluginName: string;
  key: string;
  label: string;
};

export function triggerOptions(installedIds: string[]): TriggerOption[] {
  return PLUGINS.filter((p) => installedIds.includes(p.id)).flatMap((p) =>
    p.triggers.map((t) => ({ pluginId: p.id, pluginName: p.name, key: t.key, label: t.label }))
  );
}

export function actionOptions(installedIds: string[]): ActionOption[] {
  return PLUGINS.filter((p) => installedIds.includes(p.id)).flatMap((p) =>
    p.actions.map((a) => ({ pluginId: p.id, pluginName: p.name, key: a.key, label: a.label }))
  );
}

export function triggerOf(draft: AutomationDraft) {
  return getPlugin(draft.triggerPluginId)?.triggers.find((t) => t.key === draft.triggerKey);
}

export function actionOf(step: StepDraft) {
  return getPlugin(step.pluginId)?.actions.find((a) => a.key === step.actionKey);
}

/** Frase leggibile dell'automazione: «Quando arriva una email → prepara la risposta». */
export function describeDraft(draft: AutomationDraft): string {
  const when = triggerOf(draft)?.label ?? "Quando indicato";
  const then = draft.steps.map((s) => actionOf(s)?.label ?? s.actionKey);
  return then.length ? `${when} → ${then.join(" → ")}` : when;
}

/** Nome suggerito se la persona non ne scrive uno. */
export function suggestName(draft: AutomationDraft): string {
  const first = draft.steps[0];
  const action = first ? actionOf(first)?.label : undefined;
  if (action) return action.charAt(0).toUpperCase() + action.slice(1);
  return triggerOf(draft)?.label ?? "Nuova automazione";
}

/* ------------------------------- Collaboratori ------------------------------ */

export type RolePreset = {
  id: string;
  name: string;
  role: string;
  summary: string;
  plugins: string[];
  focus: string;
};

export const ROLE_PRESETS: RolePreset[] = [
  {
    id: "segreteria",
    name: "Nadia",
    role: "Segreteria",
    summary: "Legge i messaggi in arrivo, prepara le risposte e tiene in ordine l'agenda.",
    plugins: ["email", "calendario"],
    focus: "rispondere ai messaggi dei clienti e fissare gli appuntamenti",
  },
  {
    id: "amministrazione",
    name: "Ivo",
    role: "Amministrazione",
    summary: "Tiene d'occhio le fatture scadute e manda i solleciti con il tono giusto.",
    plugins: ["fatture", "email"],
    focus: "far incassare le fatture scadute senza rovinare il rapporto col cliente",
  },
  {
    id: "mercato",
    name: "Vera",
    role: "Osservatorio mercato",
    summary: "Segue i concorrenti e le pagine che ti interessano e ti riassume cosa cambia.",
    plugins: ["concorrenti", "monitoraggio"],
    focus: "capire cosa fanno i concorrenti e segnalare i cambiamenti importanti",
  },
  {
    id: "generalista",
    name: "Milo",
    role: "Assistente generale",
    summary: "Un collaboratore tuttofare: parte con poco e si specializza col tempo.",
    plugins: [],
    focus: "aiutare su richieste operative di ogni tipo",
  },
];

export const TONES = [
  { id: "cordiale", label: "Cordiale", hint: "caldo e vicino, dà del tu quando può" },
  { id: "professionale", label: "Professionale", hint: "chiaro e sobrio, dà del lei" },
  { id: "diretto", label: "Diretto", hint: "poche parole, va al punto" },
];

export type BotAnswers = {
  name: string;
  role: string;
  focus: string;
  tone: string;
  limits: string;
  plugins: string[];
};

/** Costruisce le istruzioni del collaboratore in italiano, senza gergo tecnico. */
export function composeInstructions(a: BotAnswers): string {
  const tone = TONES.find((t) => t.id === a.tone);
  const tools = a.plugins
    .map((id) => getPlugin(id))
    .filter(Boolean)
    .map((p) => `- ${p!.name}: ${p!.tagline}`);

  const lines = [
    `Ti chiami ${a.name || "Assistente"} e in questa azienda hai il ruolo di ${a.role || "assistente"}.`,
    a.focus ? `Il tuo compito principale è ${a.focus}.` : "",
    tone ? `Scrivi con un tono ${tone.label.toLowerCase()}: ${tone.hint}.` : "",
    tools.length
      ? `Strumenti su cui puoi contare:\n${tools.join("\n")}`
      : "Non hai ancora strumenti collegati: quando serve dillo con chiarezza invece di inventare dati.",
    a.limits ? `Cose che non devi fare: ${a.limits}.` : "",
    "Non inventare mai informazioni: se non hai i dati, dillo e spiega cosa serve.",
    "Rispondi sempre in italiano semplice, evitando termini tecnici.",
  ];
  return lines.filter(Boolean).join("\n\n");
}
