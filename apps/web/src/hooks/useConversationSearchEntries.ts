/**
 * Global search index owner: one place decides what ⌘K reads.
 * Engine mode indexes engine data only (routines, agents and project
 * materials via the engine snapshot); simulation keeps the simulated
 * workspace. No simulated entry can surface in engine mode.
 */

import {
  buildConversationSearchEntries,
  openWorkResultPreview,
} from "@/components/builder/conversation-search-entries";
import type { ConversationMaterial } from "@/components/builder/ConversationMaterials";
import type { ConversationScenario } from "@/components/builder/conversation-scenarios";
import type { SpaceData, SpaceView } from "@/components/builder/ConversationSpace";
import type { Work } from "@/components/builder/conversation-types";
import { workspaceWorkStatus } from "@/components/builder/conversation-work-status";
import type { EngineWorkspaceState } from "@/hooks/useEngineWorkspace";
import { useEngineMaterials } from "@/hooks/useEngineMaterials";

type Args = {
  engine: EngineWorkspaceState;
  library: ConversationMaterial[];
  visibleWorks: Work[];
  scenarios: ConversationScenario[];
  /** Engine projection in engine mode, simulated space data otherwise. */
  displaySpaceData: SpaceData;
  openSpace: (view: SpaceView, initial?: string, selected?: string) => void;
  openWork: (id: string, selector?: string) => void;
  setPreview: (value: boolean) => void;
};

export function useConversationSearchEntries({
  engine,
  library,
  visibleWorks,
  scenarios,
  displaySpaceData,
  openSpace,
  openWork,
  setPreview,
}: Args) {
  const backend = engine.backend;
  const engineMaterials = useEngineMaterials(
    backend === "engine" ? displaySpaceData.projects : [],
  );
  const workStatus = (w: Work) => workspaceWorkStatus(w, scenarios, displaySpaceData.profiles);
  return buildConversationSearchEntries({
    backend,
    library,
    visibleWorks,
    scenarios,
    spaceData: displaySpaceData,
    engineRoutines: backend === "engine" ? engine.routines : undefined,
    engineAgents: backend === "engine" ? engine.agents : undefined,
    engineMaterials: backend === "engine" ? engineMaterials : undefined,
    workStatus,
    openSpace,
    openWork,
    openResultPreview: (w) =>
      openWorkResultPreview(w, scenarios, displaySpaceData.profiles, openWork, setPreview),
  });
}
