import { useState } from "react";
import { ChevronDown, Folder, Plus } from "lucide-react";
import type { SpaceProject } from "./ConversationSpace";
export function ConversationProjectNav({
  projects,
  works,
  onProject,
  onWork,
  onAll,
  onMove,
  actions,
}: {
  projects: SpaceProject[];
  works: { id: string; title: string; projectId?: string }[];
  onProject: (id: string) => void;
  onWork: (id: string) => void;
  onAll: () => void;
  onMove: (id: string, projectId: string) => void;
  actions: (id: string) => React.ReactNode;
}) {
  const [closed, setClosed] = useState<string[]>([]);
  function toggle(id: string) {
    setClosed(closed.includes(id) ? closed.filter((v) => v !== id) : [...closed, id]);
  }
  function projectRow(p: SpaceProject) {
    const children = works.filter((w) => w.projectId === p.id);
    return (
      <div
        key={p.id}
        className="cv-project-row"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/homun-work")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          onMove(e.dataTransfer.getData("application/homun-work"), p.id);
        }}
      >
        <div>
          <button
            aria-label={`Conversazioni di ${p.name}`}
            aria-expanded={!closed.includes(p.id)}
            onClick={() => toggle(p.id)}
          >
            <ChevronDown
              size={12}
              style={{ transform: closed.includes(p.id) ? "rotate(-90deg)" : undefined }}
            />
          </button>
          <button onClick={() => onProject(p.id)}>
            <Folder size={14} />
            <span>{p.name}</span>
            <small>{children.length}</small>
          </button>
        </div>
        {!closed.includes(p.id) &&
          children.map((w) => (
            <div
              key={w.id}
              className="cv-chat-nav-row"
              draggable
              onDragStart={(e) => e.dataTransfer.setData("application/homun-work", w.id)}
            >
              <button className="cv-project-work" onClick={() => onWork(w.id)}>
                {w.title}
              </button>
              {actions(w.id)}
            </div>
          ))}
      </div>
    );
  }
  return (
    <section className="cv-project-nav" aria-label="Organizzazione progetti">
      <div className="cv-project-toolbar">
        <button onClick={onAll}>Progetti</button>
        <button aria-label="Gestisci progetti" onClick={onAll}>
          <Plus size={15} />
        </button>
      </div>
      {projects.map(projectRow)}
      {!projects.length && (
        <button className="cv-empty-projects" onClick={onAll}>
          Crea il primo progetto ↗
        </button>
      )}
    </section>
  );
}
