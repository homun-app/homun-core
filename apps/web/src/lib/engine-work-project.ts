/** Resolve (and optionally create) the project backing a work's conversation. */
import type { Work } from "../components/builder/conversation-types.ts";
import { listEngineConversations } from "./engine-domain-client.ts";
import {
  ensureEngineProjectForConversation,
} from "./engine-projects-client.ts";
import { HomunClientError } from "./homun-errors.ts";

async function conversationForWork(work: Work) {
  if (!work.engineConversationId)
    throw new HomunClientError("validation_error", "Apri prima una conversazione del motore");
  const conversations = await listEngineConversations();
  const conversation = conversations.find((c) => c.id === work.engineConversationId);
  if (!conversation) throw new HomunClientError("not_found", "Conversazione non accessibile");
  return conversation;
}

/** Read-only lookup: opening a material surface must not mutate permissions. */
export async function findEngineProjectForWork(work: Work): Promise<string | null> {
  if (work.projectId) return work.projectId;
  const conversation = await conversationForWork(work);
  return conversation.project_id ?? null;
}

export async function resolveEngineProjectForWork(
  work: Work,
  fallbackName: string,
): Promise<string> {
  const conversation = await conversationForWork(work);
  if (conversation.project_id) return conversation.project_id;
  const ensured = await ensureEngineProjectForConversation({
    conversationId: conversation.id,
    expectedVersion: conversation.version,
    name: fallbackName,
  });
  return ensured.projectId;
}
