import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { coreBridge } from "../lib/coreBridge";
import {
  filterInspectorState,
  inspectorWorkspaceReducer,
  loadInspectorState,
  loadInspectorWidthRatio,
  saveInspectorState,
  saveInspectorWidthRatio,
  type InspectorTabKind,
} from "../lib/inspectorWorkspace";
import {
  INSPECTOR_VIEW_LABEL_KEY,
  isRestorableInspectorTab,
} from "./InspectorView";
import type { ParsedArtifact } from "./MessageArtifacts";

interface UseChatInspectorWorkspaceOptions {
  artifactCatalogLoaded: boolean;
  artifactCatalogLoadError: boolean;
  threadId: string;
  translate: (key: string) => string;
  workbenchArtifacts: ParsedArtifact[];
  workspaceId?: string | null;
}

export function useChatInspectorWorkspace({
  artifactCatalogLoaded,
  artifactCatalogLoadError,
  threadId,
  translate,
  workbenchArtifacts,
  workspaceId,
}: UseChatInspectorWorkspaceOptions) {
  const [inspector, dispatchInspector] = useReducer(
    inspectorWorkspaceReducer,
    loadInspectorState(
      threadId,
      (tab) => isRestorableInspectorTab(tab, threadId, workspaceId),
    ),
  );
  const [inspectorResourcesReady, setInspectorResourcesReady] = useState(false);
  const inspectorRef = useRef(inspector);
  const inspectorRestoreScopeRef = useRef<string | null>(null);
  inspectorRef.current = inspector;
  const [inspectorRatio, setInspectorRatio] = useState(loadInspectorWidthRatio);

  const openInspectorTab = useCallback(
    (
      kind: InspectorTabKind,
      title: string,
      resourceKey: string,
      payload: Record<string, string> = {},
    ) => {
      dispatchInspector({
        type: "openTab",
        tab: {
          id: crypto.randomUUID(),
          kind,
          resourceKey,
          title,
          workspaceId: workspaceId ?? undefined,
          payload: { ...payload, threadId },
        },
      });
    },
    [threadId, workspaceId],
  );

  const openUtilityTab = useCallback(
    (kind: InspectorTabKind) => {
      openInspectorTab(kind, translate(INSPECTOR_VIEW_LABEL_KEY[kind]), `${kind}:${threadId}`);
    },
    [openInspectorTab, threadId, translate],
  );

  const openFileTab = useCallback(
    (path: string) => {
      const normalizedPath = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
      openInspectorTab(
        "file",
        normalizedPath.split("/").pop() || normalizedPath,
        `file:${normalizedPath}`,
        { path: normalizedPath },
      );
    },
    [openInspectorTab],
  );

  const openArtifactTab = useCallback(
    (artifact: ParsedArtifact) => {
      openInspectorTab(
        "artifact",
        artifact.name,
        `artifact:${artifact.thread}:${artifact.name}`,
        {
          artifactThread: artifact.thread,
          name: artifact.name,
          artifactSource: artifact.source ?? "conversation",
          projectPath: artifact.projectPath || artifact.projectRelativePath || "",
        },
      );
    },
    [openInspectorTab],
  );

  useEffect(() => {
    let cancelled = false;
    const scope = `${threadId}:${workspaceId ?? ""}`;
    const firstValidation = inspectorRestoreScopeRef.current !== scope;
    const restored = firstValidation
      ? loadInspectorState(
          threadId,
          (tab) => isRestorableInspectorTab(tab, threadId, workspaceId),
        )
      : inspectorRef.current;
    if (firstValidation) {
      inspectorRestoreScopeRef.current = scope;
      inspectorRef.current = restored;
      dispatchInspector({ type: "replaceState", state: restored });
    }
    if (firstValidation) setInspectorResourcesReady(false);

    void Promise.all(restored.tabs.map(async (tab): Promise<"allowed" | "denied" | "error"> => {
      if (tab.kind === "artifact") {
        if (!tab.payload.name) return "allowed";
        const artifact = workbenchArtifacts.find(
          (candidate) =>
            candidate.thread === tab.payload.artifactThread &&
            candidate.name === tab.payload.name,
        );
        const projectPath =
          artifact?.projectPath || artifact?.projectRelativePath || tab.payload.projectPath;
        const projectBacked = artifact?.source === "project" || tab.payload.artifactSource === "project";
        if (!artifact && !projectPath) {
          return artifactCatalogLoaded && !artifactCatalogLoadError ? "denied" : "error";
        }
        if (!projectBacked) return "allowed";
        try {
          const payload = await coreBridge.fsFile(projectPath || tab.payload.name, threadId);
          return payload.authorized ? "allowed" : "denied";
        } catch {
          return "error";
        }
      }
      if (tab.kind !== "file" || !tab.payload.path) return "allowed";
      try {
        const payload = await coreBridge.fsFile(tab.payload.path, threadId);
        return payload.authorized ? "allowed" : "denied";
      } catch {
        return "error";
      }
    })).then((outcomes) => {
      if (cancelled) return;
      const deniedIds = new Set(
        restored.tabs.filter((_, index) => outcomes[index] === "denied").map((tab) => tab.id),
      );
      const current = inspectorRef.current;
      dispatchInspector({
        type: "replaceState",
        state: filterInspectorState(
          current,
          (tab) => !deniedIds.has(tab.id),
        ),
      });
      setInspectorResourcesReady(true);
    });

    return () => {
      cancelled = true;
    };
    // Resource descriptors are restored once per authorization scope. Individual
    // open tabs revalidate again on window focus, without ever persisting content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactCatalogLoaded, artifactCatalogLoadError, threadId, workspaceId, workbenchArtifacts]);

  useEffect(() => {
    if (!inspectorResourcesReady) return;
    saveInspectorState(threadId, inspector);
  }, [inspector, inspectorResourcesReady, threadId]);

  const activateInspectorTab = useCallback((tabId: string) => {
    dispatchInspector({ type: "activateTab", tabId });
  }, []);

  const closeInspectorTab = useCallback((tabId: string) => {
    dispatchInspector({ type: "closeTab", tabId });
  }, []);

  const moveInspectorTab = useCallback((tabId: string, targetIndex: number) => {
    dispatchInspector({ type: "moveTab", tabId, targetIndex });
  }, []);

  const hideInspector = useCallback(() => {
    dispatchInspector({ type: "hideWorkspace" });
  }, []);

  const toggleInspectorFocus = useCallback(() => {
    dispatchInspector({ type: "toggleFocus" });
  }, []);

  const commitInspectorRatio = useCallback((next: number) => {
    setInspectorRatio(next);
    saveInspectorWidthRatio(next);
  }, []);

  return {
    inspector,
    inspectorRatio,
    inspectorResourcesReady,
    activateInspectorTab,
    closeInspectorTab,
    commitInspectorRatio,
    hideInspector,
    moveInspectorTab,
    openArtifactTab,
    openFileTab,
    openUtilityTab,
    toggleInspectorFocus,
  };
}
