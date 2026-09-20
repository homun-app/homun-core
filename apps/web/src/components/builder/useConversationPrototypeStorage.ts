/**
 * IndexedDB load/save for the simulated conversation prototype.
 * Storage failures stay visible; never invent a successful persist.
 */

import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { defaultPreferences, type ConversationPreferences } from "./conversation-preferences";
import type { ConversationMaterial } from "./ConversationMaterials";
import type { ConversationScenario } from "./conversation-scenarios";
import { readPrototype, savePrototype } from "./conversation-storage";
import type { SpaceData, SpaceView } from "./ConversationSpace";
import type { PrototypeSnapshot, Work } from "./conversation-types";

type ScenarioState = (ConversationScenario & { custom?: boolean })[];

type Args = {
  storageKey: string;
  loaded: boolean;
  setLoaded: Dispatch<SetStateAction<boolean>>;
  storageEnabled: boolean;
  setStorageEnabled: Dispatch<SetStateAction<boolean>>;
  setStorageStatus: Dispatch<SetStateAction<string>>;
  scenarios: ScenarioState;
  setScenarios: Dispatch<SetStateAction<ScenarioState>>;
  works: Work[];
  setWorks: Dispatch<SetStateAction<Work[]>>;
  materials: ConversationMaterial[];
  setMaterials: Dispatch<SetStateAction<ConversationMaterial[]>>;
  spaceData: SpaceData;
  setSpaceData: Dispatch<SetStateAction<SpaceData>>;
  preferences: ConversationPreferences;
  setPreferences: Dispatch<SetStateAction<ConversationPreferences>>;
  seenResults: string[];
  setSeenResults: Dispatch<SetStateAction<string[]>>;
  active: string | null;
  setActive: Dispatch<SetStateAction<string | null>>;
  space: SpaceView | null;
  setSpace: Dispatch<SetStateAction<SpaceView | null>>;
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  panel: boolean;
  setPanel: Dispatch<SetStateAction<boolean>>;
  viewer: string;
  setViewer: Dispatch<SetStateAction<string>>;
  spaceSelected: string;
  setSpaceSelected: Dispatch<SetStateAction<string>>;
  attachmentIds: MutableRefObject<WeakMap<File, string>>;
  materialDates: MutableRefObject<WeakMap<File, string>>;
};

export function useConversationPrototypeStorage(args: Args) {
  const resetting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    readPrototype<PrototypeSnapshot>(args.storageKey)
      .then((saved) => {
        if (cancelled) return;
        if (saved) {
          if (
            saved.version !== 1 ||
            !Array.isArray(saved.works) ||
            !Array.isArray(saved.scenarios) ||
            !saved.spaceData ||
            saved.works.some((w) => !saved.scenarios[w.scenario])
          ) {
            throw new Error("Invalid snapshot");
          }
          args.setScenarios(saved.scenarios);
          args.setWorks(saved.works);
          args.setMaterials(saved.materials);
          args.setSpaceData(saved.spaceData);
          args.setPreferences({ ...defaultPreferences, ...saved.preferences });
          args.setSeenResults(saved.seenResults || []);
          for (const entry of saved.attachmentMetadata || []) {
            args.attachmentIds.current.set(entry.file, entry.id);
            args.materialDates.current.set(entry.file, entry.date);
          }
          args.setActive(saved.view.active);
          args.setSpace(saved.view.space);
          args.setSidebarOpen(window.innerWidth > 800 && saved.view.sidebarOpen);
          args.setPanel(saved.view.panel);
          args.setViewer(saved.view.viewer);
          args.setSpaceSelected(saved.view.selected || "");
        }
        args.setStorageEnabled(true);
        args.setStorageStatus("Salvato in questo browser");
        args.setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          args.setStorageStatus(
            "Salvataggio non disponibile: le modifiche restano solo in questa sessione.",
          );
          args.setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [args.storageKey]);

  useEffect(() => {
    if (!args.loaded || !args.storageEnabled || resetting.current) return;
    args.setStorageStatus("Salvataggio…");
    const timer = setTimeout(() => {
      if (resetting.current) return;
      const snapshot: PrototypeSnapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        scenarios: args.scenarios,
        works: args.works,
        materials: args.materials,
        spaceData: args.spaceData,
        preferences: args.preferences,
        seenResults: args.seenResults,
        attachmentMetadata: args.works
          .flatMap((w) => w.files)
          .map((file) => ({
            file,
            id: args.attachmentIds.current.get(file) || crypto.randomUUID(),
            date: args.materialDates.current.get(file) || new Date().toISOString(),
          })),
        view: {
          active: args.active,
          space: args.space,
          sidebarOpen: args.sidebarOpen,
          panel: args.panel,
          viewer: args.viewer,
          selected: args.spaceSelected,
        },
      };
      savePrototype(args.storageKey, snapshot)
        .then(() => args.setStorageStatus("Salvato in questo browser"))
        .catch(() =>
          args.setStorageStatus(
            "Salvataggio non riuscito. Esporta una copia dalle impostazioni prima di chiudere.",
          ),
        );
    }, 250);
    return () => clearTimeout(timer);
  }, [
    args.loaded,
    args.storageEnabled,
    args.scenarios,
    args.works,
    args.materials,
    args.spaceData,
    args.preferences,
    args.seenResults,
    args.active,
    args.space,
    args.sidebarOpen,
    args.panel,
    args.viewer,
    args.spaceSelected,
    args.storageKey,
    args.attachmentIds,
    args.materialDates,
    args.setStorageStatus,
  ]);

  return { resetting };
}
