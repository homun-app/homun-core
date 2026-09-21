/**
 * Decides where a chat message goes while no agreement is confirmed (Fonte=motore).
 * A question stays in the conversation; work requests keep the durable intake path.
 * The engine-detected request language travels with the route so the brief is
 * synthesized in the person's language.
 */
import type { Work } from "@/components/builder/conversation-types";
import {
  classifyWorkIntake,
  listWorkIntakes,
  resolveFirstMessageRoute,
} from "./engine-intake-client.ts";
import { isHomunClientError } from "./homun-errors.ts";
import { isAgreementRevisable } from "./engine-intake-display.ts";

export type FirstMessageRoute = { route: "chat" | "propose"; language?: string | undefined };

export async function routeEngineFirstMessage(
  work: Work,
  text: string,
  signal?: AbortSignal,
): Promise<FirstMessageRoute> {
  const intake = (await listWorkIntakes(work.id, signal)).at(-1);
  if (intake?.status === "confirmed" && isAgreementRevisable(work)) {
    return classifyFreshRequest(work.id, text, signal);
  }
  const base = {
    hasIntake: Boolean(intake),
    intakeConfirmed: intake?.status === "confirmed",
    isNewRequest: work.title === "Nuova richiesta",
  };
  if (resolveFirstMessageRoute(base) !== "propose") return { route: "chat" };
  return classifyFreshRequest(work.id, text, signal);
}

/** Routes the first message of a just-created work: no intake can exist yet. */
export async function classifyFreshRequest(
  workId: string,
  text: string,
  signal?: AbortSignal,
): Promise<FirstMessageRoute> {
  try {
    // Classification is stateless; if it fails we keep the durable propose
    // path, which surfaces its own typed errors.
    const classification = await classifyWorkIntake(workId, text, signal);
    const route = resolveFirstMessageRoute({
      hasIntake: false,
      intakeConfirmed: false,
      isNewRequest: true,
      classification: classification.kind,
    });
    const language = classification.language ?? undefined;
    return language ? { route, language } : { route };
  } catch (cause) {
    if (isHomunClientError(cause) && cause.code === "request_cancelled") throw cause;
    return { route: "propose" };
  }
}
