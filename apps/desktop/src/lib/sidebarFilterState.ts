import type { ChatThread } from "../types";
import type { ThreadFilter, ThreadState } from "./threadFilter";

// Node contract tests and the desktop application share this dependency-free implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./sidebarFilterState.mjs";

export type SidebarFilterRootRowId =
  | "groupBy"
  | "order"
  | "states"
  | "types"
  | "period"
  | "projects"
  | "channels"
  | "showArchived";

export interface SidebarFilterStorageReader {
  getItem(key: string): string | null;
}

export interface SidebarFilterStorageWriter {
  setItem(key: string, value: string): void;
}

export interface SidebarFilterBadgeModel {
  badge: number | "dot" | null;
  badgeLabel: string | undefined;
}

export const SIDEBAR_FILTER_STORAGE_KEY = implementation.SIDEBAR_FILTER_STORAGE_KEY as string;

export const SIDEBAR_FILTER_ROOT_ROWS = implementation.SIDEBAR_FILTER_ROOT_ROWS as readonly
  SidebarFilterRootRowId[];

export const freshSidebarThreadFilter = implementation.freshSidebarThreadFilter as () => ThreadFilter;

export const readSidebarThreadFilter = implementation.readSidebarThreadFilter as (
  storage: SidebarFilterStorageReader | null | undefined,
) => ThreadFilter;

export const writeSidebarThreadFilter = implementation.writeSidebarThreadFilter as (
  storage: SidebarFilterStorageWriter | null | undefined,
  filter: unknown,
) => ThreadFilter;

export const toggleAttentionFilterStates = implementation.toggleAttentionFilterStates as (
  states: ThreadState[],
) => ThreadState[];

export const sidebarFilterBadgeModel = implementation.sidebarFilterBadgeModel as (
  count: number,
  localizedLabel: string,
) => SidebarFilterBadgeModel;

export const sidebarChannelOptions = implementation.sidebarChannelOptions as (
  availableChannels: string[],
  selectedChannels: string[],
) => string[];

export const sidebarWorkspaceIsActive = implementation.sidebarWorkspaceIsActive as (
  ownerWorkspaceId: string | null | undefined,
  activeWorkspaceId: string | null | undefined,
  personalWorkspaceId: string,
) => boolean;

export const mergeSidebarUnarchiveResult = implementation.mergeSidebarUnarchiveResult as (
  projectThreadsById: Record<string, ChatThread[]>,
  ownerWorkspaceId: string,
  threadId: string,
  snapshotThreads: ChatThread[] | null,
  ownerIsActive: boolean,
) => Record<string, ChatThread[]>;

export const canReorderSidebarThreads = implementation.canReorderSidebarThreads as (
  filter: ThreadFilter,
) => boolean;
