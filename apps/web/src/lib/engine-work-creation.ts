/** Creazione di un lavoro del motore dalla UI: conversazione + lavoro, poi
 *  l'eventuale testo della persona come MESSAGGIO (porta d'ingresso unica).
 *
 *  Mai classify niente: la creazione resta com'è, il messaggio decide il
 *  turno di ingresso del motore cosa fare (risposta, chiarimento, accordo). */
import type { Work } from "@/components/builder/conversation-types";

type CreationEngine = {
  gateError: unknown;
  createWork: (title: string, objective?: string, projectId?: string) => Promise<Work | null>;
  postMessage: (work: Work, text: string, attachments?: File[]) => Promise<void>;
};

type CreationContext = {
  engine: CreationEngine;
  open: (id: string) => void;
  setNotice: (notice: string) => void;
  bumpOwnSend?: (() => void) | undefined;
};

/** Esempio/lavoro da scenario: titolo e obiettivo sono l'identità, il testo
 *  della persona (quando c'è) va in chat come ogni altro messaggio. */
export function sendEngineExampleWork(
  ctx: CreationContext,
  input: {
    scenario: { title: string; initial?: string };
    text: string;
    attachments: File[];
    projectId?: string | undefined;
  },
): void {
  if (ctx.engine.gateError) {
    ctx.setNotice("App locale non pronta: impossibile creare il lavoro.");
    return;
  }
  // Never reuse demo scenario titles as identity — objective text is the work title.
  const raw = (input.text || input.scenario.initial || input.scenario.title || "").trim();
  const title = raw.slice(0, 100) || "Lavoro motore";
  const objective = raw || title;
  void ctx.engine.createWork(title, objective, input.projectId).then((created) => {
    if (!created) return;
    ctx.open(created.id);
    ctx.setNotice(`Lavoro creato · ${created.id}`);
    if (input.text.trim()) {
      void ctx.engine
        .postMessage(created, input.text.trim(), input.attachments)
        .catch(() => ctx.setNotice("Invio al motore non riuscito. Controlla il banner errori."));
    }
  });
}

/** Nuovo incarico per una persona: il lavoro nasce con i segnaposto e la
 *  richiesta è il primo messaggio della conversazione. */
export function sendEngineFreeWork(
  ctx: CreationContext,
  input: {
    name: string;
    text: string;
    attachments: File[];
    projectId?: string | undefined;
  },
): void {
  if (ctx.engine.gateError) {
    ctx.setNotice("App locale non pronta: impossibile creare il lavoro.");
    return;
  }
  void ctx.engine.createWork("Nuova richiesta", "", input.projectId).then((created) => {
    if (!created) return;
    ctx.open(created.id);
    ctx.setNotice(`Lavoro creato per ${input.name} · ${created.id}`);
    ctx.bumpOwnSend?.();
    const message = input.text.trim();
    if (message) {
      void ctx.engine
        .postMessage(created, message, input.attachments)
        .then(() => ctx.setNotice(""))
        .catch(() => ctx.setNotice("Invio al motore non riuscito. Controlla il banner errori."));
    }
  });
}
