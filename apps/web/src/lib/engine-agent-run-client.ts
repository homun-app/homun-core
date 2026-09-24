/** Adaptive run transport: stable operations recover lost responses. */
import { ENGINE_DEFAULT_BASE_URL } from './engine-client.ts';
import { DEFAULT_WORKSPACE_ID, defaultLocalActor, domainFetch, listEngineWorks } from './engine-domain-client.ts';
import { homunErrorFromHttp } from './homun-errors.ts';
import type { Work } from '../components/builder/conversation-types.ts';

export type AgentRun = {
  id: string; work_id: string; digest: string; expected_version: number;
  status: 'pending_approval' | 'queued' | 'running' | 'waiting_input' | 'waiting_external' | 'completed' | 'failed' | 'blocked' | 'paused' | 'cancelled';
  external_request_id?: string;
  terminal_request_id?: string;
  file_edit_request_id?: string;
  terminal?: {image?: string; policy: string; host?: string; user?: string; port?: number};
  web_pages?: {policy: string; version: number};
  external_tools?: {server_id: string; server_name: string; tool: string; name: string; description: string}[];
  tool_version: string;
  tools?: { name: string; toolset: string; version: string; schema_hash: string; definition_hash: string; kind: 'tool' | 'ask'; replay: 'read_only' | 'model' | 'never' }[];
  team?: { id: string; name: string; members: {id: string; name: string; role: string}[] };
  person?: { id: string; name: string };
  history_redacted?: boolean;
  recovery?: { status: 'waiting' | 'recovered' | 'interrupted' | 'exhausted'; phase: string; attempts: number; error_code?: string; next_attempt_at?: string };
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
export async function prepareAgentRun(work: Work, materialIds: string[], commandId: string, teamId?: string, personId?: string, serverIds?: string[], terminalImage?: string, terminalBackend?: 'local' | 'ssh', ssh?: {host: string; user: string; port: number; hostKey: string; keyPath: string}, webPages?: boolean): Promise<AgentRun> {
  const existing = (await listAgentRuns(work.id)).find(p => p.id === commandId);
  if (existing) return existing;
  const current = (await listEngineWorks()).find(w => w['id'] === work.id);
  if (!current) throw homunErrorFromHttp(404, {detail:'Lavoro non accessibile'}, 'Lavoro non accessibile');
  return request(work.id, '', { command_id: commandId, expected_version: current['version'], material_ids: materialIds, ...(terminalBackend === 'local' ? {terminal_backend: 'local'} : terminalBackend === 'ssh' && ssh ? {terminal_backend: 'ssh', ssh_host: ssh.host, ssh_user: ssh.user, ssh_port: ssh.port, ssh_host_key: ssh.hostKey, ssh_key_path: ssh.keyPath} : terminalImage ? {terminal_image: terminalImage} : {}), ...(serverIds?.length ? {server_ids: serverIds} : {}), ...(teamId ? {team_id: teamId} : {}), ...(personId ? {person_id: personId} : {}), ...(webPages ? {web_pages: true} : {}) });
}
export function approveAgentRun(workId: string, run: AgentRun, commandId: string): Promise<AgentRun> {
  return request(workId, `/${encodeURIComponent(run.id)}/approve`, {
    command_id: commandId, expected_version: run.expected_version, digest: run.digest,
  });
}

export type AgentControlAction = 'steer' | 'redirect' | 'pause' | 'resume' | 'cancel';
/** Keep this operation for retries, including the pinned version after a lost response. */
export type AgentControlOperation = { commandId: string; expectedVersion?: number };
export async function controlAgentRun(
  workId: string, runId: string, action: AgentControlAction,
  operation: AgentControlOperation, text?: string,
): Promise<AgentRun> {
  if (operation.expectedVersion === undefined) {
    const current = (await listEngineWorks()).find(w => w['id'] === workId);
    if (!current) throw homunErrorFromHttp(404, {detail:'Lavoro non accessibile'}, 'Lavoro non accessibile');
    operation.expectedVersion = current['version'] as number;
  }
  return request(workId, `/${encodeURIComponent(runId)}/control`, {
    command_id: operation.commandId, expected_version: operation.expectedVersion,
    action, ...(text !== undefined ? {text} : {}),
  });
}
