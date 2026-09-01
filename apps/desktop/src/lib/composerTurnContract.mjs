function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function modelEvidenceString(value, unavailableLabel) {
  const model = nonEmptyString(value);
  const unavailable = nonEmptyString(unavailableLabel);
  if (model && unavailable && model.toLowerCase() === unavailable.toLowerCase()) return null;
  return model;
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

function modelLabelFromSelectionEvidence(value, unavailableLabel) {
  return modelEvidenceString(modelLabelFromSelection(value), unavailableLabel);
}

export function autoModelResolutionLabel(runtimeContext, autoLabel) {
  const auto = nonEmptyString(autoLabel) ?? "Auto";
  const source = runtimeContext && typeof runtimeContext === "object" ? runtimeContext : {};
  const role = nonEmptyString(source.role);
  const provider = nonEmptyString(source.provider);
  const model = nonEmptyString(source.effective_model);
  if (role && provider && model) return `${auto} -> ${role} -> ${provider}/${model}`;
  if (provider && model) return `${auto} -> ${provider}/${model}`;
  if (model) return `${auto} -> ${model}`;
  return auto;
}

export function composerModelButtonLabel(
  effectiveModelLabel,
  selectedNextModel,
  unavailableLabel,
  autoLabel,
  runtimeContext,
) {
  return (
    modelLabelFromSelectionEvidence(selectedNextModel, unavailableLabel)
    ?? autoModelResolutionLabel(runtimeContext, autoLabel)
    ?? modelEvidenceString(effectiveModelLabel, unavailableLabel)
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
