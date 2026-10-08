import { ENGINE_DEFAULT_BASE_URL } from './engine-client.ts';
import { DEFAULT_WORKSPACE_ID, defaultLocalActor, domainFetch } from './engine-domain-client.ts';
import { homunErrorFromHttp } from './homun-errors.ts';
export type OrganizationContext = { company: string; people: string; tools: string; goals: string; team_size?: number | null };
export type OrganizationProposal = {
  id: string; revision: number; status: 'pending_confirmation' | 'confirmed' | 'failed'; error_code: string | null;
  team: null | { name: string; description: string; questions: string[]; limitations: string[];
    agents: { name: string; role: string; instructions: string; capabilities: string[]; tools_required: string[] }[] };
  team_id?: string; agent_ids?: string[];
};
export type OrganizationState = { revision: number; context: OrganizationContext; proposal: OrganizationProposal | null };
export async function organizationRequest<T>(suffix = '', body?: unknown): Promise<T> {
  const response = await domainFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}/organization${suffix}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Homun-Actor-Id': defaultLocalActor().id },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, ENGINE_DEFAULT_BASE_URL, 180_000);
  const data = await response.json();
  if (!response.ok) throw homunErrorFromHttp(response.status, data, 'Onboarding non disponibile');
  return data as T;
}
