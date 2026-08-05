import type { TurnSteeringRecord } from "./chatApi";

// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./chatSteeringPrompt.mjs";

type SteeringPromptRow = Pick<TurnSteeringRecord, "prompt" | "visible_prompt">;

export const steeringPromptWithEdit = implementation.steeringPromptWithEdit as (
  row: SteeringPromptRow,
  visiblePrompt: string,
) => string;
