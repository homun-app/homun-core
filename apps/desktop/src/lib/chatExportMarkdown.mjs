export function stripChatExportMarkers(raw = "") {
  return String(raw)
    .replace(/‹‹ARTIFACT››([\s\S]*?)‹‹\/ARTIFACT››/g, (_match, json) => {
      try {
        return `\n_[file: ${JSON.parse(json).name}]_`;
      } catch {
        return "\n_[file]_";
      }
    })
    .replace(/‹‹(ACT|PLAN|COMPOSIO_[A-Z]+)››[\s\S]*?‹‹\/\1››/g, "")
    .replace(/‹‹[A-Z_]+››|‹‹\/[A-Z_]+››/g, "")
    .trim();
}

export function chatExportRoleLabel(role) {
  if (role === "user") return "Utente";
  if (role === "assistant") return "Homun";
  return role;
}

export function buildChatMarkdown(title, messages) {
  const lines = [`# ${title || "Chat"}`, ""];
  for (const message of messages) {
    lines.push(
      `## ${chatExportRoleLabel(message.role)}`,
      "",
      stripChatExportMarkers(message.text ?? "") || "_(vuoto)_",
      "",
    );
  }
  return lines.join("\n");
}
