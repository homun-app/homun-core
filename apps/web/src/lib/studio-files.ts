export type ProjectFile = {
  id: string;
  parentId: string | null;
  name: string;
  kind: "file" | "folder";
  size: number;
  file?: File;
  access: "inherit" | "restricted";
  allowed: string[];
};
export function effectiveFileAccess(
  itemId: string,
  items: ProjectFile[],
  eligible: string[],
): string[] {
  let current = items.find((item) => item.id === itemId);
  if (!current) return [];
  let result = [...eligible];
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) return [];
    seen.add(current.id);
    if (current.access === "restricted") {
      const allowed = current.allowed;
      result = result.filter((id) => allowed.includes(id));
    }
    if (current.parentId === null) break;
    const parent = items.find((item) => item.id === current!.parentId && item.kind === "folder");
    if (!parent) return [];
    current = parent;
  }
  return result;
}
export function addLocalFiles(
  existing: ProjectFile[],
  parentId: string | null,
  files: File[],
): ProjectFile[] {
  const result = [...existing];
  const makeId = () => crypto.randomUUID();
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).split("/").filter(Boolean);
    let parent = parentId;
    for (const segment of parts.slice(0, -1)) {
      let folder = result.find(
        (item) => item.parentId === parent && item.kind === "folder" && item.name === segment,
      );
      if (!folder) {
        folder = {
          id: makeId(),
          parentId: parent,
          name: segment,
          kind: "folder",
          size: 0,
          access: "inherit",
          allowed: [],
        };
        result.push(folder);
      }
      parent = folder.id;
    }
    result.push({
      id: makeId(),
      parentId: parent,
      name: parts.at(-1) || file.name,
      kind: "file",
      size: file.size,
      file,
      access: "inherit",
      allowed: [],
    });
  }
  return result;
}
