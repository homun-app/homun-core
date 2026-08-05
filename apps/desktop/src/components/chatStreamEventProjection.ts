import type { CoreChatStreamEvent } from "../lib/coreBridge";
import {
  chatEventPartFromStream,
  shouldDropStructuredMarkerDelta,
} from "../lib/chatEventParts";
import type { ChatEventPart } from "../types";

export interface ChatStreamDraft {
  text: string;
  eventParts: ChatEventPart[];
}

interface ProjectChatStreamEventOptions {
  acceptControlEvents?: boolean;
  initialTextLength?: number;
}

export type ChatStreamProjection =
  | { kind: "ignored"; draft: ChatStreamDraft }
  | { kind: "aborted"; draft: ChatStreamDraft }
  | { kind: "done"; draft: ChatStreamDraft }
  | {
      kind: "part";
      draft: ChatStreamDraft;
      part: ChatEventPart;
      liveActivityText: string | null;
      livePlanMarkdown: string | null;
    }
  | {
      kind: "delta";
      draft: ChatStreamDraft;
      delta: string;
      firstDelta: boolean;
    };

export function projectChatStreamEvent(
  draft: ChatStreamDraft,
  payload: CoreChatStreamEvent,
  options: ProjectChatStreamEventOptions = {},
): ChatStreamProjection {
  if (options.acceptControlEvents && payload.type === "aborted") {
    return { kind: "aborted", draft: { text: "", eventParts: [] } };
  }

  if (options.acceptControlEvents && payload.type === "done" && payload.text !== undefined) {
    return { kind: "done", draft: { text: payload.text, eventParts: [] } };
  }

  const part = chatEventPartFromStream(payload);
  if (part) {
    const nextDraft = {
      ...draft,
      eventParts: [...draft.eventParts, part],
    };
    return {
      kind: "part",
      draft: nextDraft,
      part,
      liveActivityText: part.type === "activity" && part.text ? part.text.trim() : null,
      livePlanMarkdown: part.type === "plan_update" && part.markdown ? part.markdown : null,
    };
  }

  if (payload.type !== "delta") {
    return { kind: "ignored", draft };
  }
  if (shouldDropStructuredMarkerDelta(payload.delta)) {
    return { kind: "ignored", draft };
  }

  return {
    kind: "delta",
    draft: {
      ...draft,
      text: draft.text + payload.delta,
    },
    delta: payload.delta,
    firstDelta: draft.text.length === (options.initialTextLength ?? 0),
  };
}
