import type { ProactivitySuggestion } from "./coreBridge";
import type { ChatEventPart } from "../types";

// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./proactivityChatSeed.mjs";

export const buildProactivityChatSeed =
  implementation.buildProactivityChatSeed as (
    suggestion: Pick<
      ProactivitySuggestion,
      "scope" | "kind" | "title" | "body" | "choices"
    >,
    personalWorkspaceId: string,
  ) => {
    workspaceId: string;
    question: string;
    seedEventParts: ChatEventPart[];
  };
