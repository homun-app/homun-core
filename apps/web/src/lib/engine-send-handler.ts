/** Chat message routing for engine-backed works: attachments, side questions (/btw), and intake. */
import type { Work } from "@/components/builder/conversation-types.ts";
import { isEngineBackedWork } from "./conversation-engine-bridge.ts";
import { sendEngineFirstMessage } from "./engine-first-send.ts";
import { askEngineSideQuestion } from "./engine-side-question.ts";
import type { EngineWorkspaceState } from "@/hooks/useEngineWorkspace.ts";

export type EngineSendContext = {
  engine: EngineWorkspaceState;
  work: Work | null;
  text: string;
  attachments: File[];
  open: (id: string) => void;
  setNotice: (notice: string) => void;
  bumpOwnSend: () => void;
};

export function handleEngineSend({
  engine,
  work,
  text,
  attachments,
  open,
  setNotice,
  bumpOwnSend,
}: EngineSendContext): boolean {
  if (engine.backend !== "engine") return false;

  if (engine.gateError) {
    setNotice("App locale non pronta: impossibile salvare.");
    return true;
  }

  // Side question: detached query without mutating main work messages
  if (/^\/(?:btw|domanda)\s+/i.test(text)) {
    const sideQuery = text.replace(/^\/(?:btw|domanda)\s+/i, "").trim();
    if (!sideQuery) {
      setNotice("Scrivi la domanda dopo /btw, ad esempio: /btw a che punto sei?");
      return true;
    }
    if (!work || !isEngineBackedWork(work)) {
      setNotice("La domanda a margine (/btw) richiede un lavoro del motore aperto.");
      return true;
    }
    setNotice("Invio domanda a margine…");
    void askEngineSideQuestion(work.id, sideQuery)
      .then((res) => {
        setNotice(`💬 Domanda a margine (/btw):\n${res.answer}`);
      })
      .catch((err) => {
        setNotice(err instanceof Error ? err.message : "Errore nella domanda a margine.");
      });
    return true;
  }

  // Single-flight engine contract: one turn at a time
  if (engine.busy) {
    setNotice(
      "Homun sta ancora completando il turno precedente: attendi la risposta oppure premi Annulla.",
    );
    return true;
  }

  if (work && isEngineBackedWork(work)) {
    bumpOwnSend();
    void engine
      .postMessage(work, text, attachments)
      .then(() => setNotice(""))
      .catch(() => setNotice("Invio al motore non riuscito. Controlla il banner errori."));
    return true;
  }

  // First message of a new work: create draft and route
  sendEngineFirstMessage(engine, text, open, setNotice, bumpOwnSend, attachments);
  return true;
}
