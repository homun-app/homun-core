import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import parseSpdx from "spdx-expression-parse";
import spdxLicenses from "spdx-license-list/full.js";

export const EXPECTED_LICENSE_SHA256 =
  "5904c160d2d93c62e0113b5cc9d20a6880e04839bff3a130bd622cc141a64429";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultAppRoot = path.dirname(scriptDir);
const defaultRepoRoot = path.resolve(defaultAppRoot, "../..");
const legalFilePrefixes = ["license", "copying", "notice", "copyright"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packageKey(pkg) {
  return `${pkg.ecosystem}:${pkg.name}@${pkg.version}`;
}

function safePackageName(name) {
  return name.replaceAll("/", "__");
}

function repositoryUrl(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.url === "string") return value.url;
  return null;
}

export function packagesFromNpmLock(lock, packageRoot, licenseOverrides = {}) {
  return Object.entries(lock.packages ?? {})
    .filter(([key, value]) => key && value.dev !== true)
    .flatMap(([key, value]) => {
      const sourceDir = path.join(packageRoot, key);
      const packageJsonPath = path.join(sourceDir, "package.json");
      if (!existsSync(packageJsonPath)) {
        if (value.optional === true) return [];
        throw new Error(`Installed npm package metadata is missing: ${packageJsonPath}`);
      }
      const installed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const name = value.name ?? installed.name ?? key.replace(/^node_modules\//, "");
      const version = value.version ?? installed.version;
      const declaredLicense = value.license ?? installed.license;
      const overrideLicense = licenseOverrides[`${name}@${version}`];
      return [{
        ecosystem: "npm",
        name,
        version,
        license: declaredLicense ?? overrideLicense,
        licenseOverride: !declaredLicense && Boolean(overrideLicense),
        authors: installed.author ? [String(installed.author)] : [],
        repository: repositoryUrl(installed.repository),
        sourceDir,
      }];
    })
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

export function packagesFromCargoMetadata(metadata) {
  const workspace = new Set(metadata.workspace_members);
  return metadata.packages
    .filter((pkg) => !workspace.has(pkg.id))
    .map((pkg) => ({
      ecosystem: "cargo",
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      authors: pkg.authors ?? [],
      repository: pkg.repository,
      sourceDir: path.dirname(pkg.manifest_path),
    }))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

function normalizeLicenseExpression(expression) {
  return expression.replace(/\s*\/\s*/g, " OR ");
}

export function licenseIds(expression) {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error(`Unknown license expression: ${String(expression)}`);
  }
  let parsed;
  try {
    parsed = parseSpdx(normalizeLicenseExpression(expression));
  } catch (error) {
    throw new Error(`Unknown license expression: ${expression}`, { cause: error });
  }
  const ids = new Set();
  const exceptions = new Set();
  const visit = (node) => {
    if (node.license) {
      ids.add(node.license);
      if (node.exception) exceptions.add(node.exception);
      return;
    }
    visit(node.left);
    visit(node.right);
  };
  visit(parsed);
  for (const id of ids) {
    if (!spdxLicenses[id]?.licenseText) {
      throw new Error(`Unknown SPDX license identifier: ${id}`);
    }
  }
  return { ids: [...ids].sort(), exceptions: [...exceptions].sort() };
}

function runCargoMetadata(manifestPath) {
  const result = spawnSync(
    "cargo",
    ["metadata", "--locked", "--format-version", "1", "--manifest-path", manifestPath],
    { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `cargo metadata failed for ${manifestPath}\n${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function requiredFile(source, description) {
  if (!existsSync(source)) {
    throw new Error(`${description} is missing: ${source}`);
  }
  const contents = await readFile(source);
  if (contents.length === 0) {
    throw new Error(`${description} is empty: ${source}`);
  }
  return contents;
}

async function copyRequiredFile(source, target, description) {
  await requiredFile(source, description);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function legalFiles(sourceDir) {
  if (!existsSync(sourceDir)) return [];
  const entries = await readdir(sourceDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        legalFilePrefixes.some((prefix) => entry.name.toLowerCase().startsWith(prefix)),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function discoverNpmPackages(repoRoot, appRoot) {
  const browserRoot = path.join(repoRoot, "runtimes", "browser-automation");
  const roots = [appRoot, browserRoot];
  const licenseOverrides = await readJson(
    path.join(repoRoot, "compliance", "npm-license-overrides.json"),
  );
  const packages = [];
  for (const root of roots) {
    const lockPath = path.join(root, "package-lock.json");
    await requiredFile(lockPath, "npm lockfile");
    packages.push(
      ...packagesFromNpmLock(await readJson(lockPath), root, licenseOverrides),
    );
  }
  return packages;
}

function discoverCargoPackages(repoRoot) {
  const manifests = [
    path.join(repoRoot, "Cargo.toml"),
    path.join(repoRoot, "runtimes", "channel-telegram", "Cargo.toml"),
    path.join(repoRoot, "runtimes", "channel-whatsapp", "Cargo.toml"),
  ];
  return manifests.flatMap((manifest) =>
    packagesFromCargoMetadata(runCargoMetadata(manifest))
  );
}

function deduplicatePackages(packages) {
  const unique = new Map();
  for (const pkg of packages) unique.set(packageKey(pkg), pkg);
  return [...unique.values()].sort((a, b) => packageKey(a).localeCompare(packageKey(b)));
}

function pythonNotice(inventory) {
  const lines = [
    "# Python Runtime and Model Notices",
    "",
    "These components are not embedded in the Homun application binary.",
    "Python packages are installed when their container image is built; the model is downloaded at runtime.",
    "",
    "| Component | Version | License | Distribution | Source |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const pkg of inventory.packages ?? []) {
    lines.push(
      `| ${pkg.name} | ${pkg.version} | ${pkg.license} | ${pkg.distribution} | ${pkg.source} |`,
    );
  }
  const model = inventory.model;
  if (model) {
    lines.push(
      `| ${model.name} | model | ${model.license} | ${model.distribution} | ${model.source} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function aggregateNotice(packages) {
  const lines = [
    "# Homun Third-Party Notices",
    "",
    "Homun itself is licensed under FSL-1.1-ALv2. This index covers separately licensed components distributed with or fetched by the desktop package.",
    "",
    "## Electron and Chromium",
    "",
    "Electron's MIT license and Chromium's generated notices are stored under `third-party-licenses/electron/`.",
    "",
    "## Dependency inventory",
    "",
    "| Ecosystem | Package | Version | Declared license | Authors or repository |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const pkg of packages) {
    const attribution = [...(pkg.authors ?? []), pkg.repository]
      .filter(Boolean)
      .join("; ");
    lines.push(
      `| ${pkg.ecosystem} | ${pkg.name} | ${pkg.version} | ${pkg.license} | ${attribution} |`,
    );
  }
  lines.push(
    "",
    "## Fonts",
    "",
    "Fontsource license files and the generated font index are stored under `third-party-licenses/fonts/`.",
    "",
    "## Default skills",
    "",
    "The vendored default-skill snapshot's MIT license is stored under `third-party-licenses/default-skills/`.",
    "",
    "## Python runtime and model",
    "",
    "Pinned Python package declarations and the runtime-downloaded model notice are stored under `third-party-licenses/python-runtime/`.",
    "",
  );
  return lines.join("\n");
}

export async function stageLicenseCompliance(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const appRoot = options.appRoot ?? defaultAppRoot;
  const resourcesDir = options.resourcesDir ?? path.join(appRoot, ".package", "resources");
  const expectedLicenseSha256 =
    options.expectedLicenseSha256 ?? EXPECTED_LICENSE_SHA256;
  const productLicense = path.join(repoRoot, "LICENSE.md");
  const productLicenseContents = await requiredFile(productLicense, "Canonical product license");
  if (sha256(productLicenseContents) !== expectedLicenseSha256) {
    throw new Error(
      `canonical product license SHA-256 mismatch: expected ${expectedLicenseSha256}, got ${sha256(productLicenseContents)}`,
    );
  }

  const npmPackages = options.npmPackages ?? await discoverNpmPackages(repoRoot, appRoot);
  const cargoPackages = options.cargoPackages ?? discoverCargoPackages(repoRoot);
  const packages = deduplicatePackages([...cargoPackages, ...npmPackages]);
  const thirdPartyDir = path.join(resourcesDir, "third-party-licenses");
  await rm(path.join(resourcesDir, "LICENSE.md"), { force: true });
  await rm(path.join(resourcesDir, "THIRD_PARTY_NOTICES.md"), { force: true });
  await rm(thirdPartyDir, { recursive: true, force: true });
  await mkdir(resourcesDir, { recursive: true });
  await copyFile(productLicense, path.join(resourcesDir, "LICENSE.md"));

  const electronRoot = path.join(appRoot, "node_modules", "electron");
  await copyRequiredFile(
    path.join(electronRoot, "LICENSE"),
    path.join(thirdPartyDir, "electron", "LICENSE"),
    "Electron/Chromium notice",
  );
  await copyRequiredFile(
    path.join(electronRoot, "dist", "LICENSES.chromium.html"),
    path.join(thirdPartyDir, "electron", "LICENSES.chromium.html"),
    "Electron/Chromium notice",
  );

  const spdxIds = new Set();
  const exceptionIds = new Set();
  for (const pkg of packages) {
    let parsed;
    try {
      parsed = licenseIds(pkg.license);
    } catch (error) {
      throw new Error(`Unknown license for ${pkg.name}@${pkg.version}: ${pkg.license}`, {
        cause: error,
      });
    }
    parsed.ids.forEach((id) => spdxIds.add(id));
    parsed.exceptions.forEach((id) => exceptionIds.add(id));
    const target = path.join(
      thirdPartyDir,
      pkg.ecosystem,
      `${safePackageName(pkg.name)}@${pkg.version}`,
    );
    const packageLegalFiles = await legalFiles(pkg.sourceDir);
    if (pkg.licenseOverride && packageLegalFiles.length === 0) {
      throw new Error(
        `License override for ${pkg.name}@${pkg.version} requires a bundled legal file`,
      );
    }
    for (const filename of packageLegalFiles) {
      await copyRequiredFile(
        path.join(pkg.sourceDir, filename),
        path.join(target, filename),
        `Package-specific legal file for ${pkg.name}@${pkg.version}`,
      );
    }
  }

  const pythonInventoryPath = path.join(repoRoot, "compliance", "python-runtime.json");
  const pythonInventory = await readJson(pythonInventoryPath);
  for (const item of [...(pythonInventory.packages ?? []), pythonInventory.model].filter(Boolean)) {
    const parsed = licenseIds(item.license);
    parsed.ids.forEach((id) => spdxIds.add(id));
    parsed.exceptions.forEach((id) => exceptionIds.add(id));
  }

  for (const id of [...spdxIds].sort()) {
    const text = spdxLicenses[id]?.licenseText;
    if (!text) throw new Error(`Unknown SPDX license identifier: ${id}`);
    const target = path.join(thirdPartyDir, "spdx", `${id}.txt`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text.endsWith("\n") ? text : `${text}\n`);
  }
  for (const id of [...exceptionIds].sort()) {
    const source = path.join(repoRoot, "compliance", "licenses", `${id}.txt`);
    await copyRequiredFile(
      source,
      path.join(thirdPartyDir, "exceptions", `${id}.txt`),
      `SPDX exception text for ${id}`,
    );
  }

  const fontRoot = path.join(repoRoot, "runtimes", "contained-computer", "fonts");
  await copyRequiredFile(
    path.join(fontRoot, "THIRD_PARTY_NOTICES.md"),
    path.join(thirdPartyDir, "fonts", "THIRD_PARTY_NOTICES.md"),
    "Font notice index",
  );
  const fontLicenses = path.join(fontRoot, "licenses");
  if (!existsSync(fontLicenses)) {
    throw new Error(`Font license directory is missing: ${fontLicenses}`);
  }
  await cp(fontLicenses, path.join(thirdPartyDir, "fonts", "licenses"), {
    recursive: true,
  });
  await copyRequiredFile(
    path.join(repoRoot, "resources", "default-skills", "LICENSE.md"),
    path.join(thirdPartyDir, "default-skills", "LICENSE.md"),
    "Default-skill MIT license",
  );
  await copyRequiredFile(
    pythonInventoryPath,
    path.join(thirdPartyDir, "python-runtime", "inventory.json"),
    "Python runtime inventory",
  );
  await writeFile(
    path.join(thirdPartyDir, "python-runtime", "NOTICE.md"),
    pythonNotice(pythonInventory),
  );
  await writeFile(
    path.join(resourcesDir, "THIRD_PARTY_NOTICES.md"),
    aggregateNotice(packages),
  );

  return { resourcesDir, packages };
}

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  const resourcesDir = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !resourcesDir) {
    throw new Error("--output requires a directory path");
  }
  const result = await stageLicenseCompliance({
    resourcesDir: resourcesDir ? path.resolve(resourcesDir) : undefined,
  });
  console.log(`Prepared license compliance bundle at ${result.resourcesDir}`);
  console.log(`Indexed ${result.packages.length} locked third-party packages`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
