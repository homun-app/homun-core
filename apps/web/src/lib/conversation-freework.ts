import { initialScenarios, type ConversationScenario } from "@/components/builder/conversation-scenarios.ts";
import { memberProfile } from "@/components/builder/conversation-members.ts";
import type { SpaceData } from "@/components/builder/ConversationSpace.ts";

export function buildFreeWorkSpec(
  name: string,
  text: string,
  spaceData: SpaceData,
): ConversationScenario {
  return {
    ...initialScenarios[0]!,
    agent: name,
    icon: name.slice(0, 1),
    role: memberProfile(name, spaceData.profiles).role,
    color: "sage",
    custom: true,
    title: text.slice(0, 100),
    initial: text,
    input: "Le informazioni necessarie per questo incarico",
    help: "Allega materiali o descrivi vincoli, fonti e risultato atteso. Se non servono altri materiali, scrivilo qui.",
    outcome: "Un risultato coerente con la richiesta, da verificare insieme.",
    steps: [
      "Concordare risultato, informazioni e vincoli",
      "Preparare il lavoro e segnalare eventuali dubbi",
      "Consegnare il risultato per la tua verifica",
    ],
    result: "Consegna dimostrativa",
    body:
      "# Consegna dimostrativa\n\n## Incarico\n" +
      text +
      "\n\n## Risultato\nIl motore non è collegato: nessun lavoro è stato eseguito. Questa scheda serve a provare revisione e approvazione.\n\n## Da verificare nel prodotto finale\nRisultato completo, materiali utilizzati, fonti, limiti e azioni proposte.",
  };
}
