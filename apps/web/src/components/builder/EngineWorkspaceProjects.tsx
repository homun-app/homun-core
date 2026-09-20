/** Read-only authoritative projects and their real work links. */
import type { SpaceProject } from './ConversationSpace';
import type { Work } from './conversation-types';

export function EngineWorkspaceProjects({ projects, works, selected, onProject, onWork }: {
  projects: SpaceProject[];
  works: Work[];
  selected: string;
  onProject: (id: string) => void;
  onWork: (id: string) => void;
}) {
  const visible = selected ? projects.filter(project => project.id === selected) : projects;
  return <section className="cw-workspace" aria-label="Progetti del motore">
    <div className="cw-panel-top"><h2>Progetti</h2><span className="cw-hint">Fonte: motore</span></div>
    {selected && <button className="cs-link" onClick={() => onProject('')}>Tutti i progetti</button>}
    {!visible.length && <p>Nessun progetto disponibile.</p>}
    {visible.map(project => <section key={project.id}>
      <h3><button className="cs-link" onClick={() => onProject(project.id)}>{project.name}</button></h3>
      {project.brief && <p>{project.brief}</p>}
      {works.filter(work => work.projectId === project.id).map(work => <p key={work.id}><button className="cw-secondary" onClick={() => onWork(work.id)}>{work.title} ↗</button></p>)}
    </section>)}
  </section>;
}
