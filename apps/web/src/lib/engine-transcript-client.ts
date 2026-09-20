/** Durable, actor-authorized history; never falls back to browser demo state. */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import { DEFAULT_WORKSPACE_ID, defaultLocalActor, domainFetch } from "./engine-domain-client.ts";
import { assistantFromPosted } from "./conversation-engine-bridge.ts";
import { parseWorkPatchProposal } from "./interpretation-display.ts";
import { HomunClientError, homunErrorFromHttp } from "./homun-errors.ts";
import type { ConversationMessage } from "../components/builder/conversation-types.ts";

export async function loadEngineTranscript(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationMessage[]> {
  const actor = defaultLocalActor();
  const messages: ConversationMessage[] = [];
  const seen = new Set<string>();
  let after = 0;
  for (let page = 0; page < 1000; page++) {
    const response = await domainFetch(
      `/v1/workspaces/${DEFAULT_WORKSPACE_ID}/conversations/${encodeURIComponent(conversationId)}/messages?after=${after}&limit=200`,
      {
        method: "GET",
        headers: { Accept: "application/json", "X-Homun-Actor-Id": actor.id },
        ...(signal ? { signal } : {}),
      },
      ENGINE_DEFAULT_BASE_URL,
      15_000,
    );
    const body = await response.json();
    if (!response.ok)
      throw homunErrorFromHttp(response.status, body, "Impossibile caricare lo storico dal motore");
    if (
      !Array.isArray(body.items) ||
      !Number.isSafeInteger(body.cursor) ||
      typeof body.has_more !== "boolean"
    ) {
      throw new HomunClientError("validation_error", "Risposta storico non valida");
    }
    for (const item of body.items) {
      if (
        typeof item.id !== "string" ||
        typeof item.text !== "string" ||
        typeof item.author_id !== "string"
      ) {
        throw new HomunClientError("validation_error", "Messaggio storico non valido");
      }
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (item.author_id === "homun_engine") {
        messages.push(
          assistantFromPosted({
            assistantMessageId: item.id,
            assistantText: item.text,
            patchProposal: parseWorkPatchProposal(item.patch_proposal),
          }),
        );
        continue;
      }
      messages.push({
        who: "you",
        engineMessageId: item.id,
        sender:
          item.author_id === "homun_engine"
            ? "Homun"
            : item.author_id === actor.id
              ? actor.displayName
              : item.author_id,
        text: item.text,
      });
    }
    if (!body.has_more) return messages;
    if (body.cursor <= after)
      throw new HomunClientError("validation_error", "Il cursore dello storico non avanza");
    after = body.cursor;
  }
  throw new HomunClientError(
    "validation_error",
    "Storico troppo esteso: caricamento interrotto senza mostrare risultati parziali",
  );
}

export type TranscriptAnnotation = Pick<
  ConversationMessage,
  "engineMessageId" | "memorySaved" | "patchResolved"
>;

/** Preserve only UI annotations on rows still returned by the authorized endpoint. */
export function mergeTranscriptAnnotations(
  messages: ConversationMessage[],
  previous: TranscriptAnnotation[],
): ConversationMessage[] {
  const byId = new Map(
    previous.filter((m) => m.engineMessageId).map((m) => [m.engineMessageId, m]),
  );
  return messages.map((message) => {
    const old = byId.get(message.engineMessageId);
    return {
      ...message,
      ...(old?.memorySaved ? { memorySaved: true } : {}),
      ...(old?.patchResolved ? { patchResolved: old.patchResolved } : {}),
    };
  });
}

export function currentTranscriptActions(
  messages: ConversationMessage[],
  workVersion: number,
): ConversationMessage[] {
  return messages.map((message) => {
    if (!message.patchProposal || message.patchProposal.base_version === workVersion)
      return message;
    const { patchProposal: _stale, ...historical } = message;
    return historical;
  });
}
