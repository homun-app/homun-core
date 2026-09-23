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

/** What the panel tells the person to do next, in product language. */
export function engineWorkPanelMessage(
  status: string,
  intake?: { status: string; capability?: string } | null,
): string {
  if (intake?.status === 'pending_confirmation')
    return 'Homun ha preparato una proposta in chat: confermala per affidare il lavoro.';
  if (intake?.status === 'failed')
    return 'La proposta non è stata completata: riprendila dalla conversazione.';
  if (status === 'draft' && intake?.status === 'confirmed') {
    if (intake.capability === 'compare_csv')
      return 'Accordo confermato: aggiungi i due listini nella conversazione e Homun preparerà l’azione da approvare.';
    if (intake.capability === 'read_material')
      return 'Accordo confermato: carica il materiale nella conversazione e Homun preparerà l’azione da approvare.';
    if (intake.capability === 'synthesize')
      return 'Accordo confermato: scegli i documenti per la sintesi nella sezione «Scrivi la sintesi» e approva l’esecuzione.';
    return 'Il riepilogo è confermato: i prossimi passi si concordano in chat.';
  }
  switch (status) {
    case 'draft': return 'Homun sta preparando la proposta, oppure è in attesa della tua conferma. Controlla la scheda nella conversazione.';
    case 'running': return 'Esecuzione in corso. Lo stato e il risultato si aggiornano nella conversazione.';
    case 'review': return 'Il risultato è pronto per la tua revisione. Aprilo nella conversazione per leggere i dettagli e scaricare i file.';
    case 'completed': return 'Lavoro completato. I risultati restano disponibili nella conversazione.';
    case 'failed': return 'Esecuzione non completata. Controlla l’errore nella conversazione.';
    case 'paused': return 'Lavoro in pausa.';
    case 'cancelled': return 'Lavoro chiuso senza eseguirlo: l’accordo resta nello storico della conversazione.';
    case 'waiting_input': return 'In attesa del tuo contributo nella conversazione.';
    default: return 'Le proposte e le approvazioni disponibili sono nella conversazione.';
  }
}
