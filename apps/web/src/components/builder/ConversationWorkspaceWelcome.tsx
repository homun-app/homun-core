import { useState } from "react";
import { FolderPlus, Users, Sparkles, FileSearch, ArrowUpRight } from "lucide-react";
import { EngineOrganizationOnboarding } from "./EngineOrganizationOnboarding";
import { ConversationAvatar } from "./ConversationAvatar";
import { isHumanMember } from "./conversation-members";
import type { ConversationScenario } from "./conversation-scenarios";
import type { SpaceData } from "./ConversationSpace";
import "./conversation-welcome-refined.css";

const EXAMPLE_LABELS = [
  "Prepariamo il catalogo",
  "Studiamo il mercato",
  "Mettiamo ordine nei log",
] as const;

type Props = {
  assignee: string;
  scenarios: ConversationScenario[];
  spaceData: SpaceData;
  onCreateExample: (index: number) => void;
  engineMode?: boolean;
  onRefreshEngine?: (() => Promise<void>) | undefined;
  onOpenSpace?: ((space: "Progetti" | "Squadra" | "Materiali", initial?: string, selected?: string) => void) | undefined;
};

export function ConversationWorkspaceWelcome({
  assignee,
  scenarios,
  spaceData,
  onCreateExample,
  engineMode = false,
  onRefreshEngine,
  onOpenSpace,
}: Props) {
  const [showTeamOnboarding, setShowTeamOnboarding] = useState(false);

  return (
    <div className="cw-welcome-linear">
      <div className="cw-welcome-mark">H</div>
      <h1 className="cw-welcome-title">
        {assignee ? `Cosa affidiamo a ${assignee}?` : "Come possiamo aiutarti oggi?"}
      </h1>
      <p className="cw-welcome-subtitle">
        {assignee
          ? "Descrivi l'obiettivo, i vincoli e i materiali. L'agente si occuperà dell'esecuzione."
          : "Chiedi quello che ti serve, assegna compiti alla squadra o avvia un nuovo progetto."}
      </p>

      <div className="cw-welcome-pills">
        {onOpenSpace && (
          <button
            type="button"
            className="cw-welcome-pill"
            onClick={() => onOpenSpace("Progetti", "", "new")}
          >
            <FolderPlus size={13} />
            <span>Nuovo progetto</span>
          </button>
        )}

        {engineMode ? (
          <button
            type="button"
            className="cw-welcome-pill"
            onClick={() => setShowTeamOnboarding((v) => !v)}
          >
            <Users size={13} />
            <span>{showTeamOnboarding ? "Nascondi configurazione squadra" : "Costruisci squadra con AI"}</span>
          </button>
        ) : (
          scenarios.slice(0, 3).map((s, i) =>
            !spaceData.removedPeople?.includes(s.agent) ? (
              <button
                key={s.title}
                type="button"
                className="cw-welcome-pill"
                onClick={() => onCreateExample(i)}
              >
                <ConversationAvatar
                  name={s.agent}
                  human={isHumanMember(s.agent, spaceData.profiles)}
                />
                <span>{EXAMPLE_LABELS[i]}</span>
                <ArrowUpRight size={12} />
              </button>
            ) : null
          )
        )}

        {onOpenSpace && (
          <button
            type="button"
            className="cw-welcome-pill"
            onClick={() => onOpenSpace("Materiali")}
          >
            <FileSearch size={13} />
            <span>Consulta materiali</span>
          </button>
        )}
      </div>

      {engineMode && showTeamOnboarding && (
        <div className="cw-welcome-inline-onboarding">
          <EngineOrganizationOnboarding onChanged={onRefreshEngine} />
        </div>
      )}
    </div>
  );
}

