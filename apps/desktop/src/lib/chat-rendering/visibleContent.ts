// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./visibleContent.mjs";

export const visibleAssistantText = implementation.visibleAssistantText as (text?: string) => string;
