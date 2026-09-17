import type { AssignedWork, TodayProject } from "./StudioToday";
import type { TrainingActivity } from "./StudioTraining";
import { StudioWorkForm } from "./StudioWorkForm";
export function StudioQuickWork({
  people,
  projects,
  onSave,
  onClose,
}: {
  people: { id: string; name: string; activities?: TrainingActivity[] }[];
  projects: TodayProject[];
  onSave: (tasks: AssignedWork[]) => void;
  onClose: () => void;
}) {
  return (
    <StudioWorkForm
      people={people}
      projects={projects}
      onSave={(task) => onSave([task])}
      onClose={onClose}
    />
  );
}
