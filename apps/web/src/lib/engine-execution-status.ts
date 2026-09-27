/** Shared lifecycle policy for durable execution panels. */
export function executionPolls(status: string): boolean {
  return ['queued', 'running', 'waiting_input', 'waiting_external', 'waiting_automation', 'paused'].includes(status);
}
export function executionRefreshes(status: string, previous?: string): boolean {
  return status !== previous && (['paused', 'waiting_automation'].includes(previous ?? '')
    || ['completed', 'waiting_input', 'waiting_external', 'waiting_automation', 'paused', 'cancelled', 'failed', 'blocked'].includes(status));
}
