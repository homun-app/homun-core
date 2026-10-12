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
import type { EngineMaterialsState, EngineMaterialsStatus } from "@/lib/engine-material-library";

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

/** Health of the engine sources behind the search index, stated in its footer. */
export type ConversationSearchSources = {
  /**
   * Independently fetched material source; null in simulation, where no
   * engine source exists. The other engine entries (works, messages,
   * routines, agents, projects, teams) all come from the workspace
   * snapshot, whose failure already surfaces through the engine banner
   * (ConversationWorkspaceEngineNotices) — no second notice here.
   */
  materials: { status: EngineMaterialsStatus; error: unknown } | null;
};

/** One rule for the footer status, pure so it stays testable without React. */
export function searchMaterialsSource(
  backend: "engine" | "simulation",
  engineOnline: boolean,
  probe: EngineMaterialsState,
  gateError: unknown,
): ConversationSearchSources["materials"] {
  if (backend !== "engine") return null;
  // Offline the snapshot projection is cleared, so probing the (empty)
  // project list would report a false ok: the gate error is the honest
  // reason the source is down.
  if (!engineOnline) return { status: "unavailable", error: gateError };
  return { status: probe.status, error: probe.error };
}

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
  const engineOnline = backend === "engine" && engine.gateError == null;
  const materials = useEngineMaterials(
    backend === "engine" ? displaySpaceData.projects : [],
    engineOnline,
  );
  const workStatus = (w: Work) => workspaceWorkStatus(w, scenarios, displaySpaceData.profiles);
  return {
    entries: buildConversationSearchEntries({
      backend,
      library,
      visibleWorks,
      scenarios,
      spaceData: displaySpaceData,
      engineRoutines: backend === "engine" ? engine.routines : undefined,
      engineAgents: backend === "engine" ? engine.agents : undefined,
      engineMaterials: backend === "engine" ? materials.items : undefined,
      workStatus,
      openSpace,
      openWork,
      openResultPreview: (w) =>
        openWorkResultPreview(w, scenarios, displaySpaceData.profiles, openWork, setPreview),
    }),
    sources: {
      materials: searchMaterialsSource(backend, engineOnline, materials, engine.gateError),
    },
  };
}
