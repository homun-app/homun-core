import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateFontLicenseCoverage } from "./font-license-coverage.mjs";

const requiredFiles = [
  "LICENSE.md",
  "THIRD_PARTY_NOTICES.md",
  "third-party-licenses/electron/LICENSE",
  "third-party-licenses/electron/LICENSES.chromium.html",
  "third-party-licenses/fonts/THIRD_PARTY_NOTICES.md",
  "third-party-licenses/fonts/LICENSE_MANIFEST.json",
  "third-party-licenses/default-skills/LICENSE.md",
  "third-party-licenses/python-runtime/inventory.json",
  "third-party-licenses/python-runtime/NOTICE.md",
];

const requiredDirectories = [
  "third-party-licenses/cargo",
  "third-party-licenses/npm",
  "third-party-licenses/fonts/licenses",
  "third-party-licenses/spdx",
];

function containsNonEmptyFile(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && statSync(target).size > 0) return true;
    if (entry.isDirectory() && containsNonEmptyFile(target)) return true;
  }
  return false;
}

export function verifyLicenseResources(resourcesDir) {
  if (!resourcesDir) throw new Error("License resource directory is required");
  for (const relativePath of requiredFiles) {
    const target = path.join(resourcesDir, relativePath);
    if (!existsSync(target)) {
      throw new Error(`Required license artifact is missing: ${relativePath}`);
    }
    if (!statSync(target).isFile() || statSync(target).size === 0) {
      throw new Error(`Required license artifact ${relativePath} is empty`);
    }
  }
  validateFontLicenseCoverage({
    fontRoot: path.join(resourcesDir, "contained-computer", "fonts"),
    licenseRoot: path.join(resourcesDir, "third-party-licenses", "fonts"),
  });
  for (const relativePath of requiredDirectories) {
    const target = path.join(resourcesDir, relativePath);
    if (!existsSync(target)) {
      throw new Error(`Required license directory is missing: ${relativePath}`);
    }
    if (!statSync(target).isDirectory() || !containsNonEmptyFile(target)) {
      throw new Error(`Required license directory ${relativePath} is empty`);
    }
  }
  return true;
}

function main() {
  const resourcesIndex = process.argv.indexOf("--resources");
  const resourcesDir = resourcesIndex >= 0 ? process.argv[resourcesIndex + 1] : undefined;
  if (!resourcesDir) throw new Error("--resources requires a directory path");
  verifyLicenseResources(path.resolve(resourcesDir));
  console.log(`Verified license compliance resources at ${path.resolve(resourcesDir)}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
