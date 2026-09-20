/** Preserve a request even when synthesis fails; a draft is not an assignment. */
import {
  createEngineConversationAndWork,
  parseEngineWorkRecord,
  postEngineConversationMessage,
} from "./conversation-engine-bridge.ts";
import { defaultLocalActor, listEngineWorks } from "./engine-domain-client.ts";
import { classifyFreshRequest } from "./engine-first-message-routing.ts";
import { proposeWorkIntake } from "./engine-intake-client.ts";
import { isHomunClientError } from "./homun-errors.ts";
export async function createIntakeConversation(
  text: string,
  signal: AbortSignal,
  onError: (error: unknown) => void,
) {
  const created = await createEngineConversationAndWork({
    title: "Nuova richiesta",
    objective: "Obiettivo da concordare",
    actor: defaultLocalActor(),
  });
  try {
    // The first message gets the same question/work routing as any other:
    // a question stays in the conversation instead of forcing a work brief.
    const routed = await classifyFreshRequest(created.workId, text, signal);
    if (routed.route === "chat") {
      await postEngineConversationMessage({
        conversationId: created.conversationId,
        text,
        actor: defaultLocalActor(),
        signal,
      });
    } else {
      await proposeWorkIntake(
        created.workId,
        text,
        created.record.version,
        crypto.randomUUID(),
        signal,
        routed.language,
      );
    }
  } catch (cause) {
    if (!(isHomunClientError(cause) && cause.code === "request_cancelled")) onError(cause);
  }
  const raw = (await listEngineWorks()).find((item) => item["id"] === created.workId);
  return raw ? parseEngineWorkRecord(raw) : created.record;
}
