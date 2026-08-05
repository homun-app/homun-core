function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function selectedModelAfterSubmission(selectedModel, accepted) {
  return accepted ? null : selectedModel ?? null;
}

export function effectiveModelFromGateway(value) {
  return nonEmptyString(value);
}

export function modelLabelFromSelection(value) {
  const selected = nonEmptyString(value);
  if (!selected) return null;
  const parts = selected.split("::");
  return nonEmptyString(parts[parts.length - 1]) ?? selected;
}

export function composerModelButtonLabel(effectiveModelLabel, selectedNextModel, unavailableLabel) {
  return (
    modelLabelFromSelection(selectedNextModel)
    ?? nonEmptyString(effectiveModelLabel)
    ?? nonEmptyString(unavailableLabel)
    ?? "Unavailable"
  );
}

export function latestAssistantEffectiveModel(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return nonEmptyString(message.model);
  }
  return null;
}
