import type { Work } from "@/components/builder/conversation-types";

type FirstSendEngine = {
  createWork: (title: string, objective: string, draftOnly?: boolean) => Promise<Work | null>;
  postMessage: (work: Work, text: string) => Promise<void>;
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
): void {
  void engine.createWork("Nuova richiesta", text, true).then((created) => {
    if (!created) {
      setNotice("Creazione non riuscita. Controlla le impostazioni dei modelli.");
      return;
    }
    open(created.id);
    setNotice("");
    bumpOwnSend();
    void engine
      .postMessage(created, text)
      .catch(() => setNotice("Invio al motore non riuscito. Controlla il banner errori."));
  });
}
