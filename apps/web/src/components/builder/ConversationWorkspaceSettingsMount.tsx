/**
 * Settings dialog mount for ConversationWorkspace — keeps the shell under the
 * legacy line budget while preserving deep-link sections.
 */
import { ConversationSettings } from "./ConversationSettings";
import type { ConversationPreferences } from "./conversation-preferences";
import type { ConversationMaterial } from "./ConversationMaterials";
import type { SpaceData } from "./ConversationSpace";
import type { Work } from "./conversation-types";
import { downloadPrototypeExport } from "./conversation-export";
import { resetPrototype } from "./conversation-storage";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

type Props = {
  open: boolean;
  initialSection: string;
  preferences: ConversationPreferences;
  onSave: (p: ConversationPreferences) => void;
  onClose: () => void;
  storageStatus: string;
  visibleWorks: Work[];
  displaySpaceData: SpaceData;
  engineBackend: "simulation" | "engine";
  library: ConversationMaterial[];
  works: Work[];
  setWorks: Dispatch<SetStateAction<Work[]>>;
  onNavigate: (page: "Squadra" | "Plugin" | "Materiali" | "Progetti") => void;
  spaceData: SpaceData;
  storageKey: string;
  resetting: MutableRefObject<boolean>;
};

export function ConversationWorkspaceSettingsMount({
  open,
  initialSection,
  preferences,
  onSave,
  onClose,
  storageStatus,
  visibleWorks,
  displaySpaceData,
  engineBackend,
  library,
  works,
  setWorks,
  onNavigate,
  spaceData,
  storageKey,
  resetting,
}: Props) {
  if (!open) return null;
  return (
    <ConversationSettings
      value={preferences}
      onSave={onSave}
      onClose={onClose}
      initialSection={initialSection}
      storageStatus={storageStatus}
      counts={{
        works: visibleWorks.filter((w) => !w.coordinatedBy).length,
        projects: displaySpaceData.projects.length,
        materials: engineBackend === "engine" ? null : library.length,
      }}
      archived={works.filter((w) => w.archived && !w.coordinatedBy)}
      onRestore={(id) =>
        setWorks((current) =>
          current.map((w) =>
            w.id === id || w.coordinatedBy === id ? { ...w, archived: false } : w,
          ),
        )
      }
      onNavigate={(page) => {
        onClose();
        onNavigate(page);
      }}
      onExport={() =>
        downloadPrototypeExport({
          preferences,
          spaceData,
          works,
          materials: library,
        })
      }
      onReset={async () => {
        resetting.current = true;
        try {
          await resetPrototype(storageKey);
          window.location.reload();
        } catch (error) {
          resetting.current = false;
          throw error;
        }
      }}
    />
  );
}
