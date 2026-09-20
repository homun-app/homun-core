/** Source-explicit projection for shared navigation; never persist engine data as simulation. */
import type { SpaceData } from '../components/builder/ConversationSpace.tsx';
import type { EngineProject } from './engine-projects-client.ts';

export function projectWorkspaceData(
  backend: 'engine' | 'simulation',
  simulation: SpaceData,
  projects: EngineProject[],
): SpaceData {
  if (backend === 'simulation') return simulation;
  return { ...simulation, projects: projects.map((project) => ({
    id: project.id, name: project.name, brief: project.description,
    teamId: project.team_ids[0] ?? '',
  })) };
}

export function engineWorkPanelMessage(status: string): string {
  switch (status) {
    case 'running': return 'Esecuzione in corso sul motore. Lo stato e il risultato si aggiornano nella conversazione.';
    case 'review': return 'Il report è pronto per la revisione umana. Apri il report nella conversazione per leggere i dettagli e scaricare i risultati.';
    case 'completed': return 'Lavoro completato sul motore. I risultati registrati restano disponibili nella conversazione.';
    case 'failed': return 'Esecuzione non completata. Controlla l’errore nella conversazione prima di preparare un nuovo confronto.';
    case 'paused': return 'Lavoro in pausa sul motore.';
    case 'cancelled': return 'Lavoro annullato sul motore.';
    case 'waiting_input': return 'Il motore attende il contributo richiesto nella conversazione.';
    default: return 'Il lavoro è registrato sul motore. Le proposte e le approvazioni disponibili sono nella conversazione.';
  }
}
