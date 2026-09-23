import { ENGINE_DEFAULT_BASE_URL } from './engine-client.ts';
import { DEFAULT_WORKSPACE_ID, defaultLocalActor, domainFetch } from './engine-domain-client.ts';
import { homunErrorFromHttp } from './homun-errors.ts';
export type ContributionInvitation = { id: string; request_id: string; recipient_name: string; status: string; expires_at: string; token?: string };
export type InvitationList = { requests: { id: string; need: string; recipient_id: string; recipient_name: string | null }[]; invitations: ContributionInvitation[] };
export async function invitationRequest<T>(suffix: string, body?: unknown): Promise<T> {
  const response = await domainFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}${suffix}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Homun-Actor-Id': defaultLocalActor().id },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, ENGINE_DEFAULT_BASE_URL, 30_000);
  const data = await response.json();
  if (!response.ok) throw homunErrorFromHttp(response.status, data, 'Invito non disponibile');
  return data as T;
}
export function contributionLink(token: string, pageUrl: string, engineUrl = ENGINE_DEFAULT_BASE_URL): string {
  const url = new URL(pageUrl);
  url.search = "";
  url.hash = new URLSearchParams({ contribution: token, engine: engineUrl }).toString();
  return url.toString();
}
export type ContributionPortalView = { work_title: string; need: string; recipient_name: string; recipient_id: string; status: string; expires_at: string; response_text: string | null };
export async function portalRequest<T>(engine: string, token: string, action: 'read' | 'respond', text?: string): Promise<T> {
  const base = new URL(engine);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Indirizzo motore non valido');
  const response = await fetch(`${base.origin}/v1/contribution-portal/${action}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(action === 'respond' ? { body: JSON.stringify({ text }) } : {}),
    credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  const data = await response.json();
  if (!response.ok) throw homunErrorFromHttp(response.status, data, 'Contributo non disponibile');
  return data as T;
}

export type ContributionPerson = { id: string; name: string };
export async function listPeople(): Promise<ContributionPerson[]> {
  return (await invitationRequest<{items: ContributionPerson[]}>('/people')).items;
}

export function createPerson(name: string, commandId: string): Promise<ContributionPerson> {
  return invitationRequest<ContributionPerson>('/people', { command_id: commandId, name });
}
