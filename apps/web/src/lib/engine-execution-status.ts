/** Shared lifecycle policy for durable execution panels. */
export function executionPolls(status: string): boolean {
  return ['queued', 'running', 'waiting_input', 'waiting_external', 'paused'].includes(status);
}
export function executionRefreshes(status: string, previous?: string): boolean {
  return status !== previous && (previous === 'paused'
    || ['completed', 'waiting_input', 'waiting_external', 'paused', 'cancelled', 'failed', 'blocked'].includes(status));
}
