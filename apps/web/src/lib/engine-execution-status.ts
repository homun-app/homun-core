/** Shared lifecycle policy for durable execution panels. */
export function executionPolls(status: string): boolean {
  return ['queued', 'running', 'waiting_input', 'paused'].includes(status);
}
export function executionRefreshes(status: string, previous?: string): boolean {
  return status !== previous && (previous === 'paused'
    || ['completed', 'waiting_input', 'paused', 'cancelled', 'failed', 'blocked'].includes(status));
}
