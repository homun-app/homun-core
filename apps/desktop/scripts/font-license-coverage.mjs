import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function requiredText(target, description) {
  if (!existsSync(target)) throw new Error(`${description} is missing: ${target}`);
  if (!statSync(target).isFile() || statSync(target).size === 0) {
    throw new Error(`${description} is empty: ${target}`);
  }
  return readFileSync(target, "utf8");
}

function manifestTarget(root, relativePath, description) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`${description} is not a safe relative path: ${String(relativePath)}`);
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${description} escapes its root: ${relativePath}`);
  }
  return target;
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

export function validateFontLicenseCoverage({ fontRoot, licenseRoot = fontRoot }) {
  const manifestPath = path.join(licenseRoot, "LICENSE_MANIFEST.json");
  let manifest;
  try {
    manifest = JSON.parse(requiredText(manifestPath, "Font license manifest"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Font license manifest is invalid JSON: ${manifestPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!Array.isArray(manifest.fonts) || manifest.fonts.length === 0) {
    throw new Error("Font license manifest must contain at least one font entry");
  }

  const notice = requiredText(
    path.join(licenseRoot, "THIRD_PARTY_NOTICES.md"),
    "Font notice index",
  );
  const declaredFonts = [];
  const seenFamilies = new Set();
  for (const entry of manifest.fonts) {
    for (const field of ["family", "package", "version", "license"]) {
      if (typeof entry?.[field] !== "string" || !entry[field].trim()) {
        throw new Error(`Font license manifest entry has no ${field}`);
      }
    }
    if (seenFamilies.has(entry.family)) {
      throw new Error(`Font license manifest repeats family: ${entry.family}`);
    }
    seenFamilies.add(entry.family);
    if (!Array.isArray(entry.fontFiles) || entry.fontFiles.length === 0) {
      throw new Error(`Font license manifest has no font files for ${entry.family}`);
    }
    if (!Array.isArray(entry.licenseFiles) || entry.licenseFiles.length === 0) {
      throw new Error(`Font license manifest has no legal files for ${entry.family}`);
    }
    const expectedNoticeRow =
      `| ${entry.family} | ${entry.package} | ${entry.version} | ${entry.license} |`;
    if (!notice.includes(expectedNoticeRow)) {
      throw new Error(`Font notice index is missing ${entry.family}`);
    }
    for (const fontFile of entry.fontFiles) {
      if (!fontFile.endsWith(".woff2")) {
        throw new Error(`Font manifest entry is not WOFF2: ${fontFile}`);
      }
      requiredText(
        manifestTarget(fontRoot, fontFile, "Font file"),
        `Font file ${fontFile}`,
      );
      declaredFonts.push(fontFile);
    }
    for (const legalFile of entry.licenseFiles) {
      if (!legalFile.startsWith("licenses/")) {
        throw new Error(`Font legal file must be under licenses/: ${legalFile}`);
      }
      requiredText(
        manifestTarget(licenseRoot, legalFile, "Font legal file"),
        `Font legal file ${legalFile}`,
      );
    }
  }

  if (new Set(declaredFonts).size !== declaredFonts.length) {
    throw new Error("Font license manifest contains duplicate font files");
  }
  const shippedFonts = sorted(
    readdirSync(fontRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".woff2"))
      .map((entry) => entry.name),
  );
  const declared = sorted(declaredFonts);
  const uncovered = shippedFonts.filter((font) => !declared.includes(font));
  const missing = declared.filter((font) => !shippedFonts.includes(font));
  if (uncovered.length > 0) {
    throw new Error(
      `Font license manifest does not cover shipped files: ${uncovered.join(", ")}`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `Font license manifest references missing shipped files: ${missing.join(", ")}`,
    );
  }
  return manifest;
}
