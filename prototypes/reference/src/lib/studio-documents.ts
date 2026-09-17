import type { SharedDocument } from "../components/builder/StudioDocuments";
import type { TodayProject } from "../components/builder/StudioToday";
export const documentProjects = (doc: SharedDocument): string[] =>
  doc.projectIds ?? (doc.projectId ? [doc.projectId] : []);
const projectKey = (ids: string[]) => [...ids].sort().join("|");
export function projectAudience(
  ids: string[],
  projects: TodayProject[],
  members: string[],
): string[] {
  return ids.length
    ? [...new Set(ids.flatMap((id) => projects.find((p) => p.id === id)?.documentMembers || []))]
    : members;
}
export function documentAccess(
  doc: SharedDocument,
  all: SharedDocument[],
  projects: TodayProject[],
  members: string[],
): string[] {
  let access = projectAudience(documentProjects(doc), projects, members);
  let current: SharedDocument | undefined = doc;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) return [];
    seen.add(current.id);
    if (current.accessIds) access = access.filter((id) => current!.accessIds!.includes(id));
    if (!current.parentId) break;
    const parent = all.find(
      (d) =>
        d.id === current!.parentId &&
        d.kind === "folder" &&
        projectKey(documentProjects(d)) === projectKey(documentProjects(doc)),
    );
    if (!parent) return [];
    current = parent;
  }
  return access;
}
export function importDocumentFiles(
  all: SharedDocument[],
  files: File[],
  projectId: string | string[],
  parentId: string | null,
  accessIds?: string[],
): SharedDocument[] {
  const projectIds = typeof projectId === "string" ? (projectId ? [projectId] : []) : projectId;
  const result = [...all];
  function base(title: string, parent: string | null): SharedDocument {
    return {
      id: crypto.randomUUID(),
      title,
      author: "Fabio",
      body: "",
      version: 1,
      taskIds: [],
      history: ["Importato da Fabio"],
      projectId: projectIds[0] || "",
      projectIds,
      parentId: parent,
      ...(!parent && accessIds ? { accessIds: [...accessIds] } : {}),
    };
  }
  for (const file of files) {
    let parent = parentId;
    const path = (file.webkitRelativePath || file.name)
      .split("/")
      .filter((x) => x && x !== "." && x !== "..");
    for (const segment of path.slice(0, -1)) {
      let dir = result.find(
        (d) =>
          d.kind === "folder" &&
          d.parentId === parent &&
          projectKey(documentProjects(d)) === projectKey(projectIds) &&
          d.title === segment,
      );
      if (!dir) {
        dir = { ...base(segment, parent), kind: "folder" };
        result.push(dir);
      }
      parent = dir.id;
    }
    result.push({ ...base(file.name, parent), kind: "file", file });
  }
  return result;
}
export function moveDocument(
  all: SharedDocument[],
  id: string,
  projectId: string | string[],
): SharedDocument[] {
  const projectIds = typeof projectId === "string" ? (projectId ? [projectId] : []) : projectId;
  const ids = new Set([id]);
  let count = 0;
  while (count !== ids.size) {
    count = ids.size;
    all.forEach((d) => {
      if (d.parentId && ids.has(d.parentId)) ids.add(d.id);
    });
  }
  return all.map((d) =>
    ids.has(d.id)
      ? {
          ...d,
          projectId: projectIds[0] || "",
          projectIds,
          ...(d.id === id ? { parentId: null } : {}),
        }
      : d,
  );
}
