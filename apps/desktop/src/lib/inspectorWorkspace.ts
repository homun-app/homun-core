export type InspectorTabKind =
  | "file"
  | "artifact"
  | "memory"
  | "graph"
  | "sources"
  | "goals"
  | "activity"
  | "plan"
  | "execution"
  | "subagents"
  | "computer";

export interface InspectorTab {
  id: string;
  kind: InspectorTabKind;
  resourceKey: string;
  title: string;
  projectId?: string;
  workspaceId?: string;
  payload: Record<string, string>;
}

export interface InspectorWorkspaceState {
  open: boolean;
  focused: boolean;
  activeTabId: string | null;
  tabs: InspectorTab[];
}

export type InspectorWorkspaceAction =
  | { type: "openTab"; tab: InspectorTab }
  | { type: "activateTab"; tabId: string }
  | { type: "closeTab"; tabId: string }
  | { type: "moveTab"; tabId: string; targetIndex: number }
  | { type: "showWorkspace" }
  | { type: "hideWorkspace" }
  | { type: "toggleFocus" }
  | { type: "replaceState"; state: InspectorWorkspaceState };

export interface InspectorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface InspectorTabBounds {
  id: string;
  left: number;
  right: number;
}

export interface InspectorDropTarget {
  index: number;
  tabId: string | null;
  side: "before" | "after" | null;
}

// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./inspectorWorkspace.mjs";

export const INSPECTOR_WIDTH_RATIO_KEY = implementation.INSPECTOR_WIDTH_RATIO_KEY as string;
export const EMPTY_INSPECTOR_STATE = implementation.EMPTY_INSPECTOR_STATE as InspectorWorkspaceState;

export const inspectorStateKey = implementation.inspectorStateKey as (threadId: string) => string;
export const inspectorDropTarget = implementation.inspectorDropTarget as (
  bounds: InspectorTabBounds[],
  pointerX: number,
  draggedId: string,
) => InspectorDropTarget;
export const inspectorWorkspaceReducer = implementation.inspectorWorkspaceReducer as (
  state: InspectorWorkspaceState,
  action: InspectorWorkspaceAction,
) => InspectorWorkspaceState;
export const filterInspectorState = implementation.filterInspectorState as (
  state: InspectorWorkspaceState,
  isAllowed: (tab: InspectorTab) => boolean,
) => InspectorWorkspaceState;
export const restoreInspectorState = implementation.restoreInspectorState as (
  raw: string | null,
  isAllowed?: (tab: InspectorTab) => boolean,
) => InspectorWorkspaceState;
export const clampInspectorRatio = implementation.clampInspectorRatio as (
  value: number,
  containerWidth: number,
  minPane?: number,
) => number;
export const loadInspectorState = implementation.loadInspectorState as (
  threadId: string,
  isAllowed?: (tab: InspectorTab) => boolean,
  storage?: InspectorStorage,
) => InspectorWorkspaceState;
export const saveInspectorState = implementation.saveInspectorState as (
  threadId: string,
  state: InspectorWorkspaceState,
  storage?: InspectorStorage,
) => void;
export const loadInspectorWidthRatio = implementation.loadInspectorWidthRatio as (
  storage?: InspectorStorage,
) => number;
export const saveInspectorWidthRatio = implementation.saveInspectorWidthRatio as (
  value: number,
  storage?: InspectorStorage,
) => void;
