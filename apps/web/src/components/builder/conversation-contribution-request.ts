/**
 * La richiesta di contributo dentro un lavoro (simulazione): chi copia chi,
 * e la richiesta di un agente nasce come lavoro figlio dello stesso progetto.
 * Corpo mosso verbatim da ConversationWorkspace, che resta lo shell.
 */
import type { Dispatch, SetStateAction } from "react";
import type { SpaceData } from "./ConversationSpace";
import type { Work } from "./conversation-types";
import { isHumanMember } from "./conversation-members";

export type ContributionRequestDeps = {
  work: Work | undefined;
  viewer: string;
  spaceData: SpaceData;
  setWorks: Dispatch<SetStateAction<Work[]>>;
  /** Nuovo incarico per un agente (simulazione), nello stesso progetto. */
  createFreeWork: (name: string, text: string, attachments: File[], projectId?: string) => unknown;
};

export function createContributionRequest({
  work,
  viewer,
  spaceData,
  setWorks,
  createFreeWork,
}: ContributionRequestDeps) {
  return function requestContribution(to: string, need: string) {
    if (
      !work ||
      (work.request?.status === "pending" && work.request.childId) ||
      (viewer !== (work.requester || "Fabio") && viewer !== work.reviewer)
    )
      return;
    const childId = isHumanMember(to, spaceData.profiles)
      ? ""
      : (createFreeWork(to, need, [], work.projectId) as string | undefined);
    const request = { to, need, status: "pending" as const, ...(childId ? { childId } : {}) };
    setWorks((all) =>
      all.map((w) =>
        w.id === work.id
          ? {
              ...w,
              phase: "waiting",
              request,
              messages: [
                ...w.messages,
                { who: "you", sender: viewer, text: `Richiesta a ${to}: ${need}` },
              ],
            }
          : w,
      ),
    );
  };
}
