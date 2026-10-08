/** Exact workspace edits: listing does not write; approval sends the reviewed digest. */
import { ENGINE_DEFAULT_BASE_URL } from './engine-client.ts';
import { DEFAULT_WORKSPACE_ID, defaultLocalActor, domainFetch } from './engine-domain-client.ts';
import { homunErrorFromHttp } from './homun-errors.ts';

export type FileEdit = {
  id: string; work_id: string; path: string; operation: string; digest: string;
  status: 'pending_approval' | 'applying' | 'applied' | 'conflict' | 'outcome_unknown';
  before_sha256?: string; after_sha256?: string; diff_preview?: string;
  diagnostics?: {checked?: boolean; introduced?: string[]; preexisting?: boolean; lsp?: string; note?: string; reason?: string};
  byte_size?: number; error?: string;
};

async function request(workId: string, suffix = '', body?: unknown) {
  const response = await domainFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}/works/${encodeURIComponent(workId)}/file-edits${suffix}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'X-Homun-Actor-Id': defaultLocalActor().id},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }, ENGINE_DEFAULT_BASE_URL, 30000);
  const result = await response.json();
  if (!response.ok) throw homunErrorFromHttp(response.status, result, 'Modifica file non disponibile');
  return result;
}

export async function listFileEdits(workId: string): Promise<FileEdit[]> {
  return (await request(workId)).items;
}

export function approveFileEdit(workId: string, edit: FileEdit): Promise<FileEdit> {
  return request(workId, `/${encodeURIComponent(edit.id)}/approve`, {digest: edit.digest});
}
