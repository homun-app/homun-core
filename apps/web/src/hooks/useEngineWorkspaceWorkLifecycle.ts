/**
 * Work lifecycle actions (rename, close, start, artifact, budget, due date,
 * project, plan revision) composed into useEngineWorkspace. The public shape
 * stays EngineWorkspaceState in useEngineWorkspace.
 */
import type { EngineWorkspaceState } from "./useEngineWorkspace";
import { renameEngineWork } from "@/lib/engine-work-naming";
import {
  closeEngineWork,
  reviseEnginePlan,
  setEngineWorkBudget,
  setEngineWorkDue,
  setEngineWorkProject,
  startEngineWork,
  submitEngineArtifact,
} from "@/lib/engine-work-lifecycle";

export function useEngineWorkspaceWorkLifecycle(
  refresh: () => Promise<void>,
): Pick<
  EngineWorkspaceState,
  | "renameWork"
  | "closeWork"
  | "startWork"
  | "submitArtifact"
  | "setWorkBudget"
  | "setDue"
  | "setProject"
  | "revisePlan"
> {
  return {
    renameWork: async (work, title) => {
      await renameEngineWork(work.id, title, work.revision);
      await refresh();
    },
    closeWork: async (work) => {
      await closeEngineWork(work.id, work.revision);
      await refresh();
    },
    startWork: async (work) => {
      await startEngineWork(work.id, work.revision);
      await refresh();
    },
    submitArtifact: async (work, title, content) => {
      let version = work.revision;
      // The final human phase starts by being delivered: READY → RUNNING → REVIEW.
      if (work.engineStatus === "ready")
        version = (await startEngineWork(work.id, version)).version;
      await submitEngineArtifact(work.id, version, title, content);
      await refresh();
    },
    setWorkBudget: async (work, modelAttempts) => {
      await setEngineWorkBudget(work.id, work.engineBudget?.version ?? 1, modelAttempts);
      await refresh();
    },
    setDue: async (work, dueDate) => {
      await setEngineWorkDue(work.id, work.revision, dueDate);
      await refresh();
    },
    setProject: async (work, projectId) => {
      await setEngineWorkProject(work.id, work.revision, projectId);
      await refresh();
    },
    revisePlan: async (work, action) => {
      await reviseEnginePlan({ workId: work.id, expectedVersion: work.revision, ...action });
      await refresh();
    },
  };
}
