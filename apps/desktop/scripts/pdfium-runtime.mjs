import { createHash } from "node:crypto";
import { existsSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PDFIUM_RELEASE = "chromium/7961";
const PDFIUM_BASE_URL = `https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_RELEASE}`;

const PDFIUM_TARGETS = Object.freeze({
  "darwin-arm64": {
    asset: "pdfium-mac-arm64.tgz",
    sha256: "1193a771e0bd934530afa3df73a0d44551d8f4078442e290054e6dd38ded960f",
    archiveLibrary: "lib/libpdfium.dylib",
    library: "libpdfium.dylib",
  },
  "linux-x64": {
    asset: "pdfium-linux-x64.tgz",
    sha256: "019665c8877d46fe65f625f80fd714ab07aac68554b0636acf2a2adf9288adb2",
    archiveLibrary: "lib/libpdfium.so",
    library: "libpdfium.so",
  },
  "win32-x64": {
    asset: "pdfium-win-x64.tgz",
    sha256: "88276459349b291c41f10422dad0210f007c04d919c8fa56472b6b7c6406adf4",
    archiveLibrary: "bin/pdfium.dll",
    library: "pdfium.dll",
  },
});

export function pdfiumTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const target = PDFIUM_TARGETS[key];
  if (!target) throw new Error(`Unsupported PDFium target: ${key}`);
  return target;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function verified(file, expected) {
  return existsSync(file) && sha256(file) === expected;
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Homun-PDFium-Runtime" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`PDFium download failed: HTTP ${response.status}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

export async function stagePdfiumRuntime({
  destination,
  platform = process.platform,
  arch = process.arch,
  cacheRoot = process.env.HOMUN_PDFIUM_CACHE ?? path.join(homedir(), ".cache", "homun", "pdfium"),
} = {}) {
  if (!destination) throw new Error("PDFium destination is required");
  const target = pdfiumTarget(platform, arch);
  const cacheDir = path.join(cacheRoot, PDFIUM_RELEASE.replaceAll("/", "-"));
  const archive = path.join(cacheDir, target.asset);
  mkdirSync(cacheDir, { recursive: true });

  if (!verified(archive, target.sha256)) {
    await download(`${PDFIUM_BASE_URL}/${target.asset}`, archive);
    if (!verified(archive, target.sha256)) {
      throw new Error(`PDFium checksum mismatch for ${target.asset}`);
    }
  }

  const scratch = mkdtempSync(path.join(tmpdir(), "homun-pdfium-"));
  try {
    const tar = process.platform === "win32" ? "tar.exe" : "tar";
    const extracted = spawnSync(tar, ["-xzf", archive, "-C", scratch], {
      encoding: "utf8",
    });
    if (extracted.status !== 0) {
      throw new Error(`Could not extract PDFium: ${extracted.stderr || extracted.stdout}`);
    }

    const librarySource = path.join(scratch, target.archiveLibrary);
    const licenseSource = path.join(scratch, "LICENSE");
    const licensesSource = path.join(scratch, "licenses");
    const versionSource = path.join(scratch, "VERSION");
    for (const required of [librarySource, licenseSource, licensesSource, versionSource]) {
      if (!existsSync(required)) throw new Error(`PDFium archive is missing ${path.basename(required)}`);
    }

    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    cpSync(librarySource, path.join(destination, target.library));
    cpSync(licenseSource, path.join(destination, "LICENSE"));
    cpSync(versionSource, path.join(destination, "VERSION"));
    cpSync(licensesSource, path.join(destination, "licenses"), { recursive: true });
    return path.join(destination, target.library);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function ensureDevPdfiumRuntime() {
  const destination = path.join(homedir(), ".homun", "pdfium");
  const target = pdfiumTarget();
  const required = [
    path.join(destination, target.library),
    path.join(destination, "LICENSE"),
    path.join(destination, "VERSION"),
    path.join(destination, "licenses"),
  ];
  if (required.every(existsSync)) return destination;
  await stagePdfiumRuntime({ destination });
  return destination;
}

async function main() {
  const destinationIndex = process.argv.indexOf("--destination");
  const destination = destinationIndex >= 0 ? process.argv[destinationIndex + 1] : undefined;
  if (!destination) throw new Error("Usage: pdfium-runtime.mjs --destination <directory>");
  const library = await stagePdfiumRuntime({ destination: path.resolve(destination) });
  console.log(`Installed pinned PDFium runtime at ${library}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
