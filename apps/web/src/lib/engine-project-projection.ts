/** Source-explicit projection for shared navigation; never persist engine data as simulation. */
import type { SpaceData } from '../components/builder/ConversationSpace.ts';
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
    case 'draft': return 'Homun sta preparando la proposta, oppure è in attesa della tua conferma. Controlla la scheda nella conversazione.';
    case 'running': return 'Esecuzione in corso. Lo stato e il risultato si aggiornano nella conversazione.';
    case 'review': return 'Il risultato è pronto per la tua revisione. Aprilo nella conversazione per leggere i dettagli e scaricare i file.';
    case 'completed': return 'Lavoro completato. I risultati restano disponibili nella conversazione.';
    case 'failed': return 'Esecuzione non completata. Controlla l’errore nella conversazione.';
    case 'paused': return 'Lavoro in pausa.';
    case 'cancelled': return 'Lavoro annullato.';
    case 'waiting_input': return 'In attesa del tuo contributo nella conversazione.';
    default: return 'Le proposte e le approvazioni disponibili sono nella conversazione.';
  }
}
