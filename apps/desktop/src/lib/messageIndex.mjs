/**
 * Per-render indexes for the transcript.
 *
 * Both replace a per-row scan that made rendering superlinear: the former
 * `findPreviousUserMessage` in ChatView walked the whole list for EVERY message
 * (O(N²)) and the branch lookup was an O(B) `find` per row — paid on every
 * streaming frame, not just on thread load. Built once per render, they turn
 * both into O(1) lookups.
 *
 * Plain `.mjs` so `node --test` can exercise the logic without a build step,
 * which is why there is no type declaration alongside it.
 */

/**
 * Maps every message id to the last `user` message that PRECEDES it, or `null`
 * when there is none. This reproduces the exact semantics of the linear scan it
 * replaced, and the details matter:
 *  - the value is the message OBJECT (callers need its `.text`), never the id;
 *  - the search is strictly before the message, so a user message maps to the
 *    user message before it, never to itself;
 *  - an id that is not in the list is simply absent (`get` → `undefined`), which
 *    is what the old `findIndex`-based scan returned for an unknown id;
 *  - on a duplicated id the FIRST occurrence wins, because the old scan located
 *    the row with `findIndex`.
 *
 * @param {{id: string, role: string}[] | null | undefined} messages
 * @returns {Map<string, object|null>}
 */
export function buildPreviousUserMessageIndex(messages) {
  const index = new Map();
  let lastUserMessage = null;
  for (const message of messages ?? []) {
    if (!index.has(message.id)) index.set(message.id, lastUserMessage);
    if (message.role === "user") lastUserMessage = message;
  }
  return index;
}

/**
 * Indexes branch points by the node they hang off, replacing a per-row `find`.
 *
 * @param {{node_id: string}[] | null | undefined} branches
 * @returns {Map<string, object>}
 */
export function buildBranchIndex(branches) {
  return new Map((branches ?? []).map((branch) => [branch.node_id, branch]));
}
