import type {
  ChatAttachmentInput,
  RoutingBindingInput,
  TemplateCatalogEntry,
} from "./coreBridge";

// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./templateWorkflowPrompt.mjs";

export interface TemplateWorkflowPromptInput {
  template: TemplateCatalogEntry;
  attachment?: Pick<ChatAttachmentInput, "displayName">;
}

export interface TemplateWorkflowAutoSubmit {
  visiblePrompt: string;
  operativePrompt: string;
  routingBinding: RoutingBindingInput;
}

export const buildTemplateWorkflowAutoSubmit =
  implementation.buildTemplateWorkflowAutoSubmit as (
    input: TemplateWorkflowPromptInput,
  ) => TemplateWorkflowAutoSubmit;
