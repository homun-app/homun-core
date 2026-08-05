import type { MemoryArtifactView } from "./coreBridge";

// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./artifactProjection.mjs";

export interface ProjectedMemoryArtifact {
  name: string;
  thread: string;
  size: number;
  updated?: boolean;
  source?: "managed" | "project";
  managed_path?: string;
  projectPath?: string;
  projectRelativePath?: string;
}

export const projectMemoryArtifact = implementation.projectMemoryArtifact as (
  artifact: MemoryArtifactView,
  currentThread: string,
) => ProjectedMemoryArtifact;
