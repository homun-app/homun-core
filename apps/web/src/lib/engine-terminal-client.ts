/** Owned terminal jobs: polling reads state; only explicit actions execute. */
import { ENGINE_DEFAULT_BASE_URL } from './engine-client.ts';
import { DEFAULT_WORKSPACE_ID, defaultLocalActor, domainFetch } from './engine-domain-client.ts';
import { homunErrorFromHttp } from './homun-errors.ts';

export type TerminalJob = {
  id: string; work_id: string; command: string; image: string; digest: string;
  status: 'pending_approval' | 'dispatching' | 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead' | 'outcome_unknown';
  exit_code?: number; error?: string;
  logs?: {text: string; truncated: boolean; tail_only: boolean; line_limit: number};
};
async function request(workId: string, suffix = '', body?: unknown) {
  const response = await domainFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}/works/${encodeURIComponent(workId)}/terminal-jobs${suffix}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'X-Homun-Actor-Id': defaultLocalActor().id},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }, ENGINE_DEFAULT_BASE_URL, 30000);
  const result = await response.json();
  if (!response.ok) throw homunErrorFromHttp(response.status, result, 'Terminale Homun non disponibile');
  return result;
}
export async function listTerminalJobs(workId: string): Promise<TerminalJob[]> {
  return (await request(workId)).items;
}
export function terminalAction(workId: string, job: TerminalJob, action: 'approve' | 'refresh' | 'stop'): Promise<TerminalJob> {
  return request(workId, `/${encodeURIComponent(job.id)}/${action}`, action === 'approve' ? {digest: job.digest} : {});
}
