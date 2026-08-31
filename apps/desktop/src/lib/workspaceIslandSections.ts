// Node contract tests and the renderer share this dependency-free implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./workspaceIslandSections.mjs";

export type WorkspaceSectionId = "activity" | "browser" | "artifacts" | "sources";
export type WorkspaceSectionStatus = "idle" | "running" | "waiting" | "failed" | "unread";

export interface WorkspaceIslandInput {
  planSteps?: Array<{ status: string }>;
  activity?: string[];
  streaming?: boolean;
  executionStatus?: string | null;
  browser?: { active: boolean; snapshotVerified: boolean; failed?: boolean } | null;
  artifacts?: Array<{ id: string }>;
  sources?: Array<{ id: string }>;
}

export interface WorkspaceSection {
  id: WorkspaceSectionId;
  status: WorkspaceSectionStatus;
  badge: number | null;
  labelKey: string;
}

export const nextWorkspaceSection = implementation.nextWorkspaceSection as (
  activeSection: WorkspaceSectionId | null,
  requestedSection: WorkspaceSectionId,
) => WorkspaceSectionId | null;

export const workspaceSectionSelection = implementation.workspaceSectionSelection as (
  activeSection: WorkspaceSectionId | null,
  requestedSection: WorkspaceSectionId,
) => { activeSection: WorkspaceSectionId | null; browserDockRequested: boolean };

export const projectWorkspaceSections = implementation.projectWorkspaceSections as (
  input?: WorkspaceIslandInput,
) => WorkspaceSection[];
