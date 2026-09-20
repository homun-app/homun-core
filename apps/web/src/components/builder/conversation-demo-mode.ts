/**
 * Demo bootstrap data for the simulated workspace.
 * Keep bootstrap factories out of ConversationWorkspace.
 */

import {
  busyMaterials,
  busyProjects,
  busyRoutines,
  busyTeams,
  busyWorks,
} from "./conversation-busy-demo.ts";
import type { ConversationMaterial } from "./ConversationMaterials";
import { initialScenarios, type ConversationScenario } from "./conversation-scenarios.ts";
import type { SpaceData, SpaceView } from "./ConversationSpace";
import type { Work } from "./conversation-types.ts";
import { type DemoMode, resolveDemoMode } from "./conversation-demo-query.ts";

export type { DemoMode };
export { resolveDemoMode };

export const scaleProjects = Array.from({ length: 50 }, (_, i) => ({
  id: "scale-project-" + i,
  name: "Catalogo " + String(i + 1).padStart(2, "0"),
  brief: "Materiali e attività dimostrativi",
  teamId: "",
}));

export type DemoBootstrap = {
  scenarios: (ConversationScenario & { custom?: boolean })[];
  works: Work[];
  materials: ConversationMaterial[];
  spaceData: SpaceData;
  initialSpace: SpaceView | null;
};

export function buildDemoBootstrap(mode: DemoMode): DemoBootstrap {
  if (mode.busyDemo) {
    return {
      scenarios: busyWorks().map((w) => ({
        ...initialScenarios[w.scenario]!,
        title: w.title,
        result: "Consegna: " + w.title,
        body:
          "# " +
          w.title +
          "\n\nDocumento dimostrativo di questo lavoro.\n\n## Risultato\nRiepilogo predisposto per la verifica del richiedente. Fonti e dati sono fittizi; nessuna elaborazione reale è stata eseguita.",
      })),
      works: busyWorks().map((w, i) => ({ ...w, scenario: i })),
      materials: busyMaterials(),
      spaceData: {
        teams: busyTeams,
        projects: busyProjects,
        routines: busyRoutines,
      },
      initialSpace: "Compiti",
    };
  }
  if (mode.scaleDemo) {
    return {
      scenarios: [...initialScenarios],
      works: Array.from({ length: 100 }, (_, i) => ({
        id: "scale-work-" + i,
        title: "Verifica listini " + String(i + 1).padStart(3, "0"),
        projectId: scaleProjects[i % 50]!.id,
        scenario: i % 3,
        phase: "proposal" as const,
        due: "",
        messages: [],
        files: [],
        contribution: "",
        revision: 0,
        feedback: "",
      })),
      materials: Array.from({ length: 100 }, (_, i) => ({
        id: "scale-material-" + i,
        addedAt: new Date(Date.now() - i * 86400000).toISOString(),
        name: "Listino " + String(i + 1).padStart(3, "0") + ".txt",
        file: new File(["Dati dimostrativi"], "Listino " + (i + 1) + ".txt"),
        path: "Fornitore " + (Math.floor(i / 10) + 1) + "/Listino " + (i + 1) + ".txt",
        projectIds: [],
      })),
      spaceData: {
        teams: [],
        projects: scaleProjects,
        routines: [],
      },
      initialSpace: "Materiali",
    };
  }
  return {
    scenarios: [...initialScenarios],
    works: [],
    materials: [],
    spaceData: { teams: [], projects: [], routines: [] },
    initialSpace: null,
  };
}
