import type { Work } from "@/components/builder/conversation-types";
import type { AutonomyLevel } from "@/components/builder/conversation-preferences";

type FirstSendEngine = {
  createWork: (title: string, objective: string, draftOnly?: boolean, projectId?: string) => Promise<Work | null>;
  postMessage: (work: Work, text: string, attachments?: File[], autonomyLevel?: AutonomyLevel, modelConnectionId?: string) => Promise<void>;
};

/**
 * First message of a brand-new engine work: open the conversation immediately,
 * then let postMessage own routing so the person sees the echoed message and
 * the staged honest waits instead of a mute hero.
 */
export function sendEngineFirstMessage(
  engine: FirstSendEngine,
  text: string,
  open: (id: string) => void,
  setNotice: (notice: string) => void,
  bumpOwnSend: () => void,
  attachments?: File[],
  autonomyLevel?: AutonomyLevel,
  modelConnectionId?: string,
  projectId?: string,
): void {
  void engine.createWork("Nuova richiesta", text, true, projectId).then((created) => {
    if (!created) {
      setNotice("Creazione non riuscita. Controlla le impostazioni dei modelli.");
      return;
    }
    open(created.id);
    setNotice("");
    bumpOwnSend();
    void engine
      .postMessage(created, text, attachments, autonomyLevel, modelConnectionId)
      .catch(() => setNotice("Invio al motore non riuscito. Controlla il banner errori."));
  });
}
