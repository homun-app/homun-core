import type { ChatMessage } from "../types";

// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./chatMessagePreservation.mjs";

type MessageIdentity = Pick<ChatMessage, "id">;

export const hasPendingLocalMessages = implementation.hasPendingLocalMessages as (
  messages: MessageIdentity[],
) => boolean;

export const shouldPreserveLocalMessages =
  implementation.shouldPreserveLocalMessages as (input: {
    currentMessages: MessageIdentity[] | undefined;
    incomingMessages: MessageIdentity[];
    isProtected: boolean;
  }) => boolean;
