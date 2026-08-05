export function buildProactivityChatSeed(suggestion, personalWorkspaceId) {
  const workspaceId =
    suggestion.scope === "__personal__" ? personalWorkspaceId : suggestion.scope;
  const question = (suggestion.body ?? "").trim() || suggestion.title;
  const options = (suggestion.choices ?? [])
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
  const seedEventParts =
    options.length > 0
      ? [
          {
            type: "choice_prompt",
            payload: {
              question: "",
              multi: false,
              options,
              purpose: suggestion.kind,
            },
          },
        ]
      : [];
  return { workspaceId, question, seedEventParts };
}
