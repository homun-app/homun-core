/**
 * Il campo del Project Hub è la chat di quel progetto.
 *
 * Il testo della persona parte VERBATIM dalla stessa porta d'ingresso del
 * composer (lavoro nuovo nel progetto + conversation.post_message, con le sue
 * preferenze di autonomia e modello). Mai un segnaposto come messaggio: il «+»
 * apre solo la conversazione nuova nel progetto e aspetta le sue parole.
 */
import type { Dispatch, SetStateAction } from "react";
import type { ConversationPreferences } from "@/components/builder/conversation-preferences";
import type { EngineWorkspaceState } from "@/hooks/useEngineWorkspace";
import { handleEngineSend } from "@/lib/engine-send-handler";

type ProjectPromptDeps = {
  engine: EngineWorkspaceState;
  preferences: ConversationPreferences;
  setNewChatProjectId: Dispatch<SetStateAction<string | null>>;
  open: (id: string | null) => void;
  setNotice: (notice: string) => void;
  bumpOwnSend: () => void;
  /** Percorso di simulazione (motore non collegato). */
  createFreeWork: (name: string, text: string, attachments: File[], projectId?: string) => unknown;
};

export function useProjectPrompt(deps: ProjectPromptDeps) {
  const { engine, preferences, setNewChatProjectId, open, setNotice, bumpOwnSend, createFreeWork } =
    deps;
  return function projectPrompt(projectId: string, text = "") {
    setNewChatProjectId(projectId);
    if (!text.trim()) {
      open(null);
      return;
    }
    if (
      handleEngineSend({
        engine,
        work: null,
        text,
        attachments: [],
        open,
        setNotice,
        bumpOwnSend,
        autonomyLevel: preferences.autonomyLevel,
        modelConnectionId: preferences.preferredModelConnectionId || undefined,
        projectId,
      })
    )
      return;
    createFreeWork("Nuovo lavoro", text, [], projectId);
  };
}
