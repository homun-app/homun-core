/** «Ripeti» for engine works: decide in product language, then open the routine creator. */
import type { SpaceView } from "@/components/builder/ConversationSpace";
import { workSupportsRoutineTemplate, type RoutineWorkSource } from "./engine-routines-client.ts";

export type EngineRepeatWork = RoutineWorkSource & {
  id: string;
  source?: "simulation" | "engine" | undefined;
  engineStatus?: string | undefined;
};

export type EngineRepeatDecision = { kind: "creator" } | { kind: "unsupported"; reason: string };

/** One eligibility rule for repeating an engine work, with reasons a person can act on. */
export function engineRepeatDecision(work: EngineRepeatWork): EngineRepeatDecision {
  if (work.source !== "engine") {
    return {
      kind: "unsupported",
      reason: "Questo lavoro non è nel motore: non può diventare una routine.",
    };
  }
  if (work.engineStatus !== "completed") {
    return {
      kind: "unsupported",
      reason:
        "Solo i lavori completati diventano routine: porta questo lavoro a consegna e riprova.",
    };
  }
  if (!workSupportsRoutineTemplate(work)) {
    return {
      kind: "unsupported",
      reason:
        "Per ripetere un lavoro ogni passaggio del piano deve essere affidato a un agente della squadra: questo lavoro non ha un piano del genere.",
    };
  }
  return { kind: "creator" };
}

/** The create-routine callback the workspace hands to work panels:
 * the same engineRepeatDecision rule decides, undefined when ineligible. */
export function routineCreatorFor(
  work: EngineRepeatWork,
  create: (input: { name: string; cron: string }) => Promise<void>,
): ((input: { name: string; cron: string }) => Promise<void>) | undefined {
  return engineRepeatDecision(work).kind === "creator" ? create : undefined;
}

/** The «Ripeti» action on an engine work: open Automazioni with the creator
 * prefilled on that work, or surface the decision reason as a notice. */
export function repeatEngineWork(
  work: EngineRepeatWork,
  openSpace: (view: SpaceView, initial?: string, selected?: string) => void,
  setNotice: (notice: string) => void,
): void {
  const decision = engineRepeatDecision(work);
  if (decision.kind === "unsupported") {
    setNotice(decision.reason);
    return;
  }
  openSpace("Automazioni", work.id);
}
