/** Adaptive run transport: stable operations recover lost responses. */
import { ENGINE_DEFAULT_BASE_URL } from './engine-client.ts';
import { DEFAULT_WORKSPACE_ID, defaultLocalActor, domainFetch, listEngineWorks } from './engine-domain-client.ts';
import { homunErrorFromHttp } from './homun-errors.ts';
import type { Work } from '../components/builder/conversation-types.ts';

export type AgentRun = {
  id: string; work_id: string; digest: string; expected_version: number;
  status: 'pending_approval' | 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'blocked';
  team?: { id: string; name: string; members: {id: string; name: string; role: string}[] };
  person?: { id: string; name: string };
  history_redacted?: boolean;
  executor_name: string; connection_id: string; turns: number;
  materials: { id: string; title: string; version: number; sha256: string }[];
  limits: { max_turns: number };
  observations: { tool: string; message?: string; result: unknown }[];
  request_id?: string; artifact_id?: string; error_code?: string;
};

async function request(workId: string, suffix = '', body?: unknown) {
  const response = await domainFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}/works/${encodeURIComponent(workId)}/agent-runs${suffix}`, {
    method: body ? 'POST' : 'GET',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Homun-Actor-Id': defaultLocalActor().id },
    ...(body ? {body: JSON.stringify(body)} : {}),
  }, ENGINE_DEFAULT_BASE_URL, 30000);
  const result = await response.json();
  if (!response.ok) throw homunErrorFromHttp(response.status, result, 'Esecuzione Homun non disponibile');
  return result;
}
export async function listAgentRuns(workId: string): Promise<AgentRun[]> {
  return (await request(workId)).items;
}
export async function prepareAgentRun(work: Work, materialIds: string[], commandId: string, teamId?: string, personId?: string): Promise<AgentRun> {
  const existing = (await listAgentRuns(work.id)).find(p => p.id === commandId);
  if (existing) return existing;
  const current = (await listEngineWorks()).find(w => w['id'] === work.id);
  if (!current) throw homunErrorFromHttp(404, {detail:'Lavoro non accessibile'}, 'Lavoro non accessibile');
  return request(work.id, '', { command_id: commandId, expected_version: current['version'], material_ids: materialIds, ...(teamId ? {team_id: teamId} : {}), ...(personId ? {person_id: personId} : {}) });
}
export function approveAgentRun(workId: string, run: AgentRun, commandId: string): Promise<AgentRun> {
  return request(workId, `/${encodeURIComponent(run.id)}/approve`, {
    command_id: commandId, expected_version: run.expected_version, digest: run.digest,
  });
}
