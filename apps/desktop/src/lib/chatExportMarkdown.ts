// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./chatExportMarkdown.mjs";
import type { ChatMessage } from "../types";

type ExportableMessage = Pick<ChatMessage, "role" | "text">;

export const stripChatExportMarkers = implementation.stripChatExportMarkers as (
  raw?: string,
) => string;

export const chatExportRoleLabel = implementation.chatExportRoleLabel as (
  role: ChatMessage["role"],
) => string;

export const buildChatMarkdown = implementation.buildChatMarkdown as (
  title: string,
  messages: ExportableMessage[],
) => string;
