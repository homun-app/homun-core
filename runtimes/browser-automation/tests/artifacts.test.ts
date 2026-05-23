import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserArtifactRoot } from "../src/browser/artifacts.js";

describe("browser artifact root", () => {
  it("resolves output paths inside the task artifact root", async () => {
    const root = new BrowserArtifactRoot(await mkdtemp(path.join(tmpdir(), "browser-artifacts-")));

    const screenshot = root.outputPath("screenshots", "page.png");

    expect(screenshot).toMatch(/screenshots\/page\.png$/);
  });

  it("rejects output path traversal", async () => {
    const root = new BrowserArtifactRoot(await mkdtemp(path.join(tmpdir(), "browser-artifacts-")));

    expect(() => root.outputPath("screenshots", "../escape.png")).toThrow(/outside artifact root/);
  });

  it("allows uploads only from configured local roots", async () => {
    const uploadRoot = await mkdtemp(path.join(tmpdir(), "browser-uploads-"));
    const file = path.join(uploadRoot, "doc.txt");
    await writeFile(file, "ok", "utf8");
    const root = new BrowserArtifactRoot(await mkdtemp(path.join(tmpdir(), "browser-artifacts-")), {
      uploadRoots: [uploadRoot],
    });

    await expect(root.inputUploadPath(file)).resolves.toMatch(/doc\.txt$/);
    await expect(root.inputUploadPath(path.join(tmpdir(), "outside.txt"))).rejects.toThrow(
      /outside upload roots/,
    );
  });
});
