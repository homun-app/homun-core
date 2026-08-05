export function steeringPromptWithEdit(row, visiblePrompt) {
  if (row.visible_prompt && row.prompt.endsWith(row.visible_prompt)) {
    return `${row.prompt.slice(0, -row.visible_prompt.length)}${visiblePrompt}`;
  }
  return visiblePrompt;
}
