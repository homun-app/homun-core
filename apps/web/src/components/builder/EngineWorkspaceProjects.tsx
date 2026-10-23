/**
 * Project Hub entrypoint for engine-backed workspace projects.
 * Replaces the old minimal list with the full ProjectHubView.
 */
import type { SpaceProject } from "./ConversationSpace";
import type { Work } from "./conversation-types";
import { ProjectHubView } from "./project-hub/ProjectHubView";

export function EngineWorkspaceProjects({
  projects,
  works,
  selected,
  onProject,
  onWork,
  onProjectPrompt,
  engineMode = false,
  sidebarOpen,
  onOpenSidebar,
}: {
  projects: SpaceProject[];
  works: Work[];
  selected: string;
  onProject: (id: string) => void;
  onWork: (id: string) => void;
  onProjectPrompt?: (projectId: string, text?: string) => void;
  engineMode?: boolean | undefined;
  sidebarOpen?: boolean | undefined;
  onOpenSidebar?: (() => void) | undefined;
}) {
  return (
    <ProjectHubView
      projects={projects}
      works={works}
      selectedId={selected}
      onSelectProject={onProject}
      onOpenWork={onWork}
      onProjectPrompt={onProjectPrompt}
      engineMode={engineMode}
      sidebarOpen={sidebarOpen}
      onOpenSidebar={onOpenSidebar}
    />
  );
}
