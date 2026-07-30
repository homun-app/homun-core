import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INSTALLER_EXTENSIONS = new Set([".AppImage", ".deb", ".dmg", ".exe", ".zip"]);

function artifactNameOrder(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function createArtifactChecksums(directory, outputPath) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && INSTALLER_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => entry.name)
    .sort(artifactNameOrder);

  if (files.length === 0) {
    throw new Error(`no installer artifacts found in ${directory}`);
  }

  const entries = [];
  for (const name of files) {
    entries.push({ name, digest: await sha256(path.join(directory, name)) });
  }

  const manifest = entries.map(({ name, digest }) => `${digest}  ${name}\n`).join("");
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporary, manifest, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, outputPath);
  return entries;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const directory = path.resolve(option("--directory") ?? "dist-installers");
  const outputPath = path.resolve(option("--output") ?? path.join(directory, "SHA256SUMS.txt"));
  const entries = await createArtifactChecksums(directory, outputPath);
  console.log(`wrote ${entries.length} installer checksums to ${outputPath}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
