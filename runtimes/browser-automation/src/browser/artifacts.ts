import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export class BrowserArtifactRoot {
  readonly root: string;
  readonly uploadRoots: string[];

  constructor(root: string, options?: { uploadRoots?: string[] }) {
    this.root = path.resolve(root);
    this.uploadRoots = (options?.uploadRoots ?? []).map((entry) => path.resolve(entry));
  }

  outputPath(kind: "screenshots" | "downloads" | "uploads" | "traces" | "pdf", fileName: string) {
    if (fileName !== path.basename(fileName)) {
      throw new Error("outside artifact root");
    }
    const resolved = path.resolve(this.root, kind, fileName);
    assertInsideRoot(resolved, path.join(this.root, kind), "outside artifact root");
    return resolved;
  }

  async ensureKind(kind: "screenshots" | "downloads" | "uploads" | "traces" | "pdf") {
    await mkdir(path.join(this.root, kind), { recursive: true });
  }

  async inputUploadPath(filePath: string): Promise<string> {
    const resolved = path.resolve(filePath);
    if (!this.uploadRoots.some((root) => isInsideRoot(resolved, root))) {
      throw new Error("outside upload roots");
    }
    const real = await realpath(resolved);
    if (!this.uploadRoots.some((root) => isInsideRoot(real, root) || isInsideRoot(resolved, root))) {
      throw new Error("outside upload roots");
    }
    return real;
  }
}

function assertInsideRoot(candidate: string, root: string, message: string): void {
  if (!isInsideRoot(candidate, root)) {
    throw new Error(message);
  }
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
