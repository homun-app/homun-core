/**
 * Routine-domain actions (create standalone or from a work, pause/resume/stop,
 * update) composed into useEngineWorkspace. The public shape stays
 * EngineWorkspaceState in useEngineWorkspace.
 */
import type { Work } from "@/components/builder/conversation-types";
import type { EngineWorkspaceState } from "./useEngineWorkspace";
import {
  createEngineRoutine,
  routineEngineAction,
  routineTemplateFromWork,
  updateEngineRoutine,
} from "@/lib/engine-routines-client";
import { routineCreatorFor } from "@/lib/engine-work-repeat";

export function useEngineWorkspaceRoutines(
  works: Work[],
  refresh: () => Promise<void>,
): Pick<
  EngineWorkspaceState,
  | "createRoutine"
  | "createRoutineFromWork"
  | "routineCreatorFor"
  | "routineAction"
  | "updateRoutine"
> {
  return {
    createRoutine: async (input) => {
      await createEngineRoutine(input);
      await refresh();
    },
    createRoutineFromWork: async (workId, input) => {
      const work = works.find((w) => w.id === workId);
      if (!work || work.source !== "engine") {
        throw new Error("Lavoro modello non trovato nel motore");
      }
      const template = routineTemplateFromWork(work);
      await createEngineRoutine({
        ...input,
        conversationId: work.engineConversationId ?? "",
        template,
      });
      await refresh();
    },
    routineCreatorFor: (work) =>
      routineCreatorFor(work, async (input) => {
        await createEngineRoutine({
          ...input,
          conversationId: work.engineConversationId ?? "",
          template: routineTemplateFromWork(work),
        });
        await refresh();
      }),
    routineAction: async (routineId, action, expectedVersion) => {
      await routineEngineAction({ routineId, action, expectedVersion });
      await refresh();
    },
    updateRoutine: async (routineId, expectedVersion, changes) => {
      await updateEngineRoutine({ routineId, expectedVersion, ...changes });
      await refresh();
    },
  };
}
