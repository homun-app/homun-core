import type { CoreBranchPoint } from "./coreBridge";
import type { ChatMessage } from "../types";

// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./messageIndex.mjs";

export const buildPreviousUserMessageIndex =
  implementation.buildPreviousUserMessageIndex as (
    messages: ChatMessage[],
  ) => Map<string, ChatMessage | null>;

export const buildBranchIndex = implementation.buildBranchIndex as (
  branches: CoreBranchPoint[],
) => Map<string, CoreBranchPoint>;
