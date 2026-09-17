export type ConversationMessage = {
  id: string;
  source?: { person: string; messageId: string };
  text: string;
  files: File[];
  taskIds: string[];
  projectIds: string[];
  createdAt: string;
};
export type ConversationFilter = { taskIds: string[]; projectIds: string[]; general: boolean };
export function filterConversation(messages: ConversationMessage[], filter: ConversationFilter) {
  return messages.filter((m) =>
    filter.general
      ? !m.taskIds.length && !m.projectIds.length
      : (!filter.taskIds.length || filter.taskIds.some((id) => m.taskIds.includes(id))) &&
        (!filter.projectIds.length || filter.projectIds.some((id) => m.projectIds.includes(id))),
  );
}
export function messageProjectIds(
  explicit: string[],
  taskIds: string[],
  tasks: { id: string; project: string }[],
) {
  return [
    ...new Set([
      ...explicit,
      ...tasks.filter((t) => taskIds.includes(t.id) && t.project).map((t) => t.project),
    ]),
  ];
}
