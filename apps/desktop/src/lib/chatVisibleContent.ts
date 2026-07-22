import type { ChatEventPart } from "../types";

// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./chatVisibleContent.mjs";

export const visibleMessageText = implementation.visibleMessageText as (text?: string) => string;

export const visibleEventParts = implementation.visibleEventParts as (
  parts?: unknown[],
) => ChatEventPart[];
