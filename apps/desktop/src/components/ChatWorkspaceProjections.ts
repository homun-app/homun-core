import type { MemoryArtifactView } from "../lib/coreBridge";
import type { ChatAttachment, ChatMessage } from "../types";
import type { IslandSource } from "./InspectorView";
import {
  ARTIFACT_IMAGE_EXT,
  artifactExt,
  parseArtifacts,
  type ParsedArtifact,
} from "./MessageArtifacts";

// Persisted artifact rows need a storage-aware projection before previewing.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as artifactProjection from "../lib/artifactProjection.mjs";

const projectMemoryArtifact = artifactProjection.projectMemoryArtifact as (
  artifact: MemoryArtifactView,
  currentThread: string,
) => ParsedArtifact;

export function buildConversationArtifacts(messages: ChatMessage[]): ParsedArtifact[] {
  const seen = new Set<string>();
  const out: ParsedArtifact[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.id.endsWith("_ready")) continue;
    for (const artifact of parseArtifacts(message.text ?? "")) {
      if (!seen.has(artifact.name)) {
        seen.add(artifact.name);
        out.push(artifact);
      }
    }
  }
  return out;
}

export function buildWorkbenchArtifacts(
  conversationArtifacts: ParsedArtifact[],
  memoryArtifacts: MemoryArtifactView[],
  threadId: string,
): ParsedArtifact[] {
  const seen = new Set<string>();
  const out: ParsedArtifact[] = [];
  for (const artifact of conversationArtifacts) {
    seen.add(artifact.name);
    out.push(artifact);
  }
  for (const artifact of memoryArtifacts) {
    const displayName = artifact.project_relative_path || artifact.name;
    if (!displayName || seen.has(displayName)) continue;
    seen.add(displayName);
    out.push(projectMemoryArtifact(artifact, threadId));
  }
  return out;
}

export function buildUploadedFiles(messages: ChatMessage[]): ChatAttachment[] {
  const seen = new Set<string>();
  const out: ChatAttachment[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.id.endsWith("_ready")) continue;
    for (const attachment of message.attachments ?? []) {
      if (!seen.has(attachment.title)) {
        seen.add(attachment.title);
        out.push(attachment);
      }
    }
  }
  return out;
}

export function buildIslandSources(
  workbenchArtifacts: ParsedArtifact[],
  uploadedFiles: ChatAttachment[],
): IslandSource[] {
  const out: IslandSource[] = [];
  for (const artifact of workbenchArtifacts) {
    const name = artifact.projectRelativePath || artifact.name;
    const isImage = ARTIFACT_IMAGE_EXT.includes(artifactExt(name));
    out.push({
      name,
      kind: isImage ? "image" : "artifact",
      meta: artifact.updated ? "updated" : artifact.source === "project" ? "project" : "artifact",
      action: "artifact",
      artifactThread: artifact.thread,
      artifactName: artifact.name,
    });
  }
  for (const file of uploadedFiles) {
    out.push({
      name: file.title,
      kind: file.kind === "image" ? "image" : "file",
      meta: "uploaded",
      action: "files",
    });
  }
  return out;
}
