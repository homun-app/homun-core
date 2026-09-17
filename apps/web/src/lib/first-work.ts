export const DEMO_TOOLS = [
  { id: "files", label: "File e documenti", hint: "Materiali di riferimento" },
  { id: "web", label: "Ricerca web", hint: "Fonti e informazioni pubbliche" },
  { id: "email", label: "Email", hint: "Richieste e risposte" },
  { id: "calendar", label: "Calendario", hint: "Appuntamenti e scadenze" },
  { id: "browser", label: "Browser", hint: "Pagine e applicazioni web" },
  { id: "terminal", label: "Terminale", hint: "Comandi e strumenti tecnici" },
];

export type FirstWorkDraft = {
  need: string;
  name: string;
  responsibility: string;
  knowledge: string;
  tools: string[];
  aiPolicy: "local" | "mixed";
  budget: string;
  autonomy: "review" | "draft";
  title: string;
  outcome: string;
  context: string;
  deadline: string;
  method: string;
};

export type DemoWork = Omit<FirstWorkDraft, "method" | "budget"> & {
  steps: string[];
  budgetEuro: number | null;
  status: "da_fare";
  cost: null;
  demo: true;
};

export function emptyFirstWorkDraft(): FirstWorkDraft {
  return {
    need: "",
    name: "",
    responsibility: "",
    knowledge: "",
    tools: ["files"],
    aiPolicy: "local",
    budget: "",
    autonomy: "review",
    title: "",
    outcome: "",
    context: "",
    deadline: "",
    method:
      "Raccogliere le informazioni necessarie\nSvolgere il lavoro richiesto\nVerificare il risultato rispetto alle fonti\nPresentare il risultato e segnalare cosa manca",
  };
}

export function prepareDemoWork(
  draft: FirstWorkDraft,
): { ok: true; work: DemoWork } | { ok: false; error: string } {
  if (
    [draft.need, draft.name, draft.responsibility, draft.title, draft.outcome, draft.method].some(
      (value) => !value.trim(),
    )
  ) {
    return { ok: false, error: "Completa bisogno, collaboratore, risultato e metodo di lavoro." };
  }
  const budget = draft.budget.trim().replace(",", ".");
  const budgetEuro = draft.aiPolicy === "mixed" ? Number(budget) : null;
  if (
    draft.aiPolicy === "mixed" &&
    (!/^\d+(\.\d{1,2})?$/.test(budget) || !Number.isFinite(budgetEuro) || budgetEuro! <= 0)
  ) {
    return {
      ok: false,
      error: "Indica un limite di spesa remoto maggiore di zero, con al massimo due decimali.",
    };
  }
  const { method, budget: _budget, ...rest } = draft;
  return {
    ok: true,
    work: {
      ...rest,
      need: draft.need.trim(),
      name: draft.name.trim(),
      responsibility: draft.responsibility.trim(),
      title: draft.title.trim(),
      outcome: draft.outcome.trim(),
      tools: [...draft.tools],
      steps: method
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      budgetEuro,
      status: "da_fare",
      cost: null,
      demo: true,
    },
  };
}
