export const materialTypes = [
  "PDF",
  "Documenti",
  "Fogli di calcolo",
  "Presentazioni",
  "Immagini",
  "Audio",
  "Video",
  "Archivi",
  "Note",
  "Altro",
];
export function materialType(item: { name: string; file?: File; body?: string }): string {
  if (!item.file && item.body !== undefined) return "Note";
  const ext = item.name.split(".").pop()?.toLowerCase() || "";
  const mime = item.file?.type || "";
  if (ext === "pdf" || mime === "application/pdf") return "PDF";
  if (["doc", "docx", "odt", "rtf", "txt", "md"].includes(ext)) return "Documenti";
  if (["xls", "xlsx", "ods", "csv", "tsv"].includes(ext)) return "Fogli di calcolo";
  if (["ppt", "pptx", "odp", "key"].includes(ext)) return "Presentazioni";
  if (
    mime.startsWith("image/") ||
    ["jpg", "jpeg", "png", "gif", "webp", "svg", "heic", "avif", "tiff"].includes(ext)
  )
    return "Immagini";
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg", "flac"].includes(ext))
    return "Audio";
  if (mime.startsWith("video/") || ["mp4", "mov", "webm", "avi", "mkv"].includes(ext))
    return "Video";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "Archivi";
  return "Altro";
}
type Entry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file: (success: (file: File) => void, error: (error: unknown) => void) => void;
  createReader: () => {
    readEntries: (success: (entries: Entry[]) => void, error: (error: unknown) => void) => void;
  };
};
export async function readMaterialDrop(data: DataTransfer) {
  // Capture entries before the browser clears the drag data store.
  const roots = Array.from(data.items)
    .filter((i) => i.kind === "file")
    .map((i) => ({
      entry: i.webkitGetAsEntry?.() as Entry | null,
      file: i.getAsFile(),
    }));
  const fallback = Array.from(data.files);
  const files: { file: File; path: string }[] = [];
  let failed = 0,
    empty = 0;
  async function visit(entry: Entry, prefix: string) {
    const path = prefix + entry.name;
    try {
      if (entry.isFile)
        files.push({
          file: await new Promise<File>((resolve, reject) => entry.file(resolve, reject)),
          path,
        });
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        let count = 0;
        // Directory readers can return several batches, commonly 100 entries at a time.
        for (;;) {
          const batch = await new Promise<Entry[]>((resolve, reject) =>
            reader.readEntries(resolve, reject),
          );
          if (!batch.length) break;
          count += batch.length;
          for (const child of batch) await visit(child, path + "/");
        }
        if (!count) empty++;
      }
    } catch {
      failed++;
    }
  }
  if (roots.length)
    for (const root of roots) {
      if (root.entry) await visit(root.entry, "");
      else if (root.file)
        files.push({ file: root.file, path: root.file.webkitRelativePath || root.file.name });
      else failed++;
    }
  else
    for (const file of fallback) files.push({ file, path: file.webkitRelativePath || file.name });
  return { files, failed, empty };
}
