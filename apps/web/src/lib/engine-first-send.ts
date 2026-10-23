import type { Work } from "@/components/builder/conversation-types";
import type { AutonomyLevel } from "@/components/builder/conversation-preferences";

type FirstSendEngine = {
  createWork: (title: string, objective?: string, projectId?: string) => Promise<Work | null>;
  postMessage: (
    work: Work,
    text: string,
    attachments?: File[],
    autonomyLevel?: AutonomyLevel,
    modelConnectionId?: string,
  ) => Promise<void>;
};

/**
 * First message of a brand-new engine work: open the conversation immediately,
 * then the message goes through postMessage — the front door decides what it
 * is (reply, clarification, agreement proposal), never the UI.
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
  void engine.createWork("Nuova richiesta", "", projectId).then((created) => {
    if (!created) {
      setNotice("Creazione non riuscita. Controlla le impostazioni dei modelli.");
      return;
    }
    open(created.id);
    setNotice("");
    bumpOwnSend();
    void engine
      .postMessage(created, text, attachments, autonomyLevel, modelConnectionId)
      // L'esito del fallimento sta in chat (avviso + nota sul messaggio), mai nel piè di pagina.
      .catch(() => undefined);
  });
}
