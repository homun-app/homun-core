/**
 * Empty-state welcome for a new simulated conversation.
 */

import { ArrowUpRight } from "lucide-react";
import { ConversationAvatar } from "./ConversationAvatar";
import { isHumanMember } from "./conversation-members";
import type { ConversationScenario } from "./conversation-scenarios";
import type { SpaceData } from "./ConversationSpace";

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
};

export function ConversationWorkspaceWelcome({
  assignee,
  scenarios,
  spaceData,
  onCreateExample,
  engineMode = false,
}: Props) {
  if (engineMode) {
    return (
      <div className="cw-welcome">
        <span className="cw-overline">COMINCIAMO DA QUI</span>
        <h1>
          Scrivi cosa vuoi ottenere.
          <br />
          <em>Decidiamo insieme come farlo.</em>
        </h1>
        <p>
          Raccontami il risultato che cerchi. Ti proporrò un obiettivo chiaro e il collaboratore
          adatto, oppure un nuovo profilo da creare. Il lavoro parte dopo la tua conferma.
        </p>
        <span className="cw-example-note">
          Esempio: «Prepara il catalogo prodotti per il cliente entro venerdì».
        </span>
      </div>
    );
  }

  return (
    <div className="cw-welcome">
      <span className="cw-overline">MENO DA GESTIRE. PIÙ DA FARE.</span>
      <h1>
        {assignee ? (
          <>
            Cosa affidiamo
            <br />
            <em>a {assignee}?</em>
          </>
        ) : (
          <>
            Un pensiero in meno.
            <br />
            <em>Cominciamo da qui.</em>
          </>
        )}
      </h1>
      <p>
        Racconta cosa vuoi ottenere.
        <br />
        La tua squadra ti aiuta a portarlo a termine.
      </p>
      {!assignee && (
        <div className="cw-examples">
          {scenarios.slice(0, 3).map(
            (s, i) =>
              !spaceData.removedPeople?.includes(s.agent) && (
                <button key={s.title} onClick={() => onCreateExample(i)}>
                  <ConversationAvatar
                    name={s.agent}
                    human={isHumanMember(s.agent, spaceData.profiles)}
                  />
                  <span>
                    {EXAMPLE_LABELS[i]}
                    <small>Con {s.agent}</small>
                  </span>
                  <ArrowUpRight size={17} />
                </button>
              ),
          )}
        </div>
      )}
      <span className="cw-example-note">
        {assignee
          ? "Descrivi obiettivo, risultato atteso e vincoli. Puoi allegare i materiali."
          : "Tre esempi guidati, oppure scrivi @ per affidare un lavoro libero."}
      </span>
    </div>
  );
}
