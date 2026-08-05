export const CONTINUE_RESPONSE_PROMPT =
  "Continue the previous response from where it stopped. Do not repeat already written parts. Keep the same language and format.";

export function buildComposerPromptDecorators({ forcedSkillsId, contextText } = {}) {
  const skillPrefix = forcedSkillsId
    ? `Use the skill \`${forcedSkillsId}\` to fulfill this request.\n\n`
    : "";
  const contextPrefix = contextText ? `${contextText}\n\n` : "";
  return {
    skillPrefix,
    contextPrefix,
    augmented: Boolean(skillPrefix || contextPrefix),
  };
}

export function buildSteeringPrompt({
  skillPrefix,
  contextPrefix,
  prompt,
  replyRoleLabel,
  replyPreview,
}) {
  if (!replyRoleLabel || !replyPreview) {
    return `${skillPrefix}${contextPrefix}${prompt}`;
  }
  return [
    skillPrefix,
    contextPrefix,
    "Apply this instruction to the active task while keeping the quoted context.",
    `Quoted message (${replyRoleLabel}):`,
    replyPreview,
    "",
    "User instruction:",
    prompt,
  ].join("\n");
}

export function buildReplyContextPrompt({
  skillPrefix,
  contextPrefix,
  prompt,
  replyRoleLabel,
  replyPreview,
}) {
  return [
    skillPrefix,
    contextPrefix,
    "Reply to the quoted message keeping the context.",
    `Quoted message (${replyRoleLabel}):`,
    replyPreview,
    "",
    "User request:",
    prompt,
  ].join("\n");
}

export function buildAssistantFollowUpPrompt({ instruction, previousResponse }) {
  return [
    instruction,
    "Keep the same language as the user.",
    "",
    "Previous response:",
    previousResponse,
  ].join("\n");
}
