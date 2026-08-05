export function buildTemplateWorkflowAutoSubmit(input) {
  const isDocument = input.template.kind === "document";
  const artifactNoun = isDocument ? "document" : "presentation";
  const makeTool = isDocument ? "make_document" : "make_deck";
  const visiblePrompt = `Help me create a ${artifactNoun} using the selected template "${input.template.name}".`;
  const intakeQuestions = Array.isArray(input.template.intake_questions)
    ? input.template.intake_questions
    : [];
  const operativePrompt = [
    `The user selected a template from the Presentations catalog and wants to use it to create a new ${artifactNoun}.`,
    `template_ref=${input.template.id}`,
    `template_name=${input.template.name}`,
    `source_provider=${input.template.source_provider ?? "user_upload"}`,
    input.attachment
      ? `attached_file=${input.attachment.displayName}`
      : "attached_file=none; use the catalog template_ref and metadata as the style constraint.",
    "",
    isDocument ? "Do not generate the document yet." : "Do not generate the deck yet.",
    "Analyze the selected template as a constraint for style, layout and visual tone.",
    isDocument
      ? "First ask 2-4 essential questions to understand objective, audience, available content and tone."
      : "First ask 2-4 essential questions to understand objective, audience, available content, slide count and tone.",
    ...(intakeQuestions.length > 0
      ? [
          `Ask these template-specific questions first (one message): ${intakeQuestions
            .map((question, index) => `${index + 1}. ${question}`)
            .join(" ")}`,
        ]
      : []),
    `Once you have the answers above, call ${makeTool} directly — no plan and no confirmation step needed.`,
  ].join("\n");
  return {
    visiblePrompt,
    operativePrompt,
    routingBinding: {
      plugin_id: "presentations",
      route_id: isDocument ? "presentations.template_document" : "presentations.template_deck",
      args: { template_ref: input.template.id },
    },
  };
}
