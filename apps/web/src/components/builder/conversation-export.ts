/**
 * Download helpers for the simulated workspace prototype.
 */

import type { ConversationPreferences } from "./conversation-preferences";
import type { ConversationMaterial } from "./ConversationMaterials";
import type { SpaceData } from "./ConversationSpace";
import type { ConversationScenario } from "./conversation-scenarios";
import type { Work } from "./conversation-types";

export function downloadTextFile(filename: string, body: string) {
  const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadWorkResult(args: {
  scenario: ConversationScenario;
  work: Work;
}) {
  const { scenario, work } = args;
  downloadTextFile(
    `${scenario.result}.txt`,
    scenario.body + (work.feedback ? `\n\n## Indicazioni di revisione\n${work.feedback}` : ""),
  );
}

export function downloadPrototypeExport(args: {
  preferences: ConversationPreferences;
  spaceData: SpaceData;
  works: Work[];
  materials: ConversationMaterial[];
}) {
  const data = {
    exportedAt: new Date().toISOString(),
    version: 1,
    preferences: args.preferences,
    spaceData: args.spaceData,
    works: args.works,
    materials: args.materials,
  };
  const blob = new Blob(
    [
      JSON.stringify(
        data,
        (_key, value) =>
          value instanceof File
            ? {
                name: value.name,
                size: value.size,
                type: value.type,
                path: value.webkitRelativePath,
                contentIncluded: false,
              }
            : value,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "homun-prototipo.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
