// electron-builder `afterPack` hook, adapted from the homun-core release pipeline.
//
// Order matters: this hook runs BEFORE electron-builder signs. It
//   1. copies the verified engine bundle into Resources/engine (electron-builder's
//      resource copier rewrites symlinks to staging paths, so we copy ourselves
//      with verbatimSymlinks and re-verify the build receipt on the final tree);
//   2. signs every Mach-O file of the engine with the Developer ID identity and a
//      least-privilege entitlement set (notarization requires all nested
//      executable code to be signed);
//   3. flips Electron fuses — which rewrites the binary and invalidates any
//      signature, so it MUST happen before signing; on macOS we reset the
//      ad-hoc signature so the real signing starts clean.
//
// Verified only inside a real electron-builder build (raw `electron .` never
// invokes afterPack).
import { FuseVersion, FuseV1Options, flipFuses } from "@electron/fuses";
import { cp, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyEngineInputs } from "./package-app.mjs";
import { verifyWebAssets } from "./artifact-inventory.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const stagedEngine = path.resolve(scriptDir, "../.package/engine");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function parseDeveloperIdIdentity(output) {
  const match = /"(Developer ID Application: [^"]+)"/.exec(output);
  return match ? match[1] : null;
}

/** Resolve the packaged Electron executable per platform. */
function electronBinaryPath(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const exeName = packager.appInfo.productFilename; // "Homun"
  if (electronPlatformName === "darwin") {
    const macExe = packager.platformSpecificBuildOptions.executableName ?? exeName;
    return path.join(appOutDir, `${exeName}.app`, "Contents", "MacOS", macExe);
  }
  if (electronPlatformName === "win32") {
    return path.join(appOutDir, `${exeName}.exe`);
  }
  return path.join(appOutDir, packager.platformSpecificBuildOptions.executableName ?? exeName);
}

export function packagedResourcesPath(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName === "darwin") {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources");
  }
  return path.join(appOutDir, "resources");
}

/** Every Mach-O file in the engine bundle: the executable plus wheel dylibs/so. */
async function machOFiles(engineDir) {
  const out = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && (entry.name.endsWith(".dylib") || entry.name.endsWith(".so")
        || entry.name === "homun-engine")) out.push(full);
    }
  }
  await walk(engineDir);
  return out;
}

async function copyEngine(context) {
  if (!existsSync(stagedEngine)) throw new Error(`Staged engine missing: ${stagedEngine}`);
  const stagedHash = await verifyEngineInputs(repoRoot, stagedEngine);
  const target = path.join(packagedResourcesPath(context), "engine");
  await cp(stagedEngine, target, { recursive: true, verbatimSymlinks: true });
  if (await verifyEngineInputs(repoRoot, target) !== stagedHash) {
    throw new Error("Final application engine differs from staged engine");
  }
  await stat(path.join(target, "homun-engine"));
  return target;
}

async function signEngine(context, engineDir) {
  if (context.electronPlatformName !== "darwin" || process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return;
  // Force electron-builder to import CSC_LINK into its temporary keychain before
  // asking `security` for the resolved Developer ID identity.
  await context.packager.codeSigningInfo?.value;
  const identity = process.env.CSC_NAME
    || parseDeveloperIdIdentity(run("security", ["find-identity", "-v", "-p", "codesigning"]));
  if (!identity) {
    // Non-release local builds often have no signing certificate. The signed
    // release CI refuses to publish before reaching this hook when credentials
    // are absent; unsigned dispatch/PR builds are expected here.
    return;
  }
  const entitlements = path.join(scriptDir, "../build/entitlements.engine.mac.plist");
  const binaries = await machOFiles(engineDir);
  if (!binaries.some((file) => path.basename(file) === "homun-engine")) {
    throw new Error("Engine executable missing before signing");
  }
  // Leaves first (dylibs/so), main executable last.
  const ordered = [...binaries.filter((f) => path.basename(f) !== "homun-engine"),
                   ...binaries.filter((f) => path.basename(f) === "homun-engine")];
  for (const file of ordered) {
    run("codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp",
                     "--entitlements", entitlements, file]);
  }
}

export default async function afterPack(context) {
  const engineDir = await copyEngine(context);
  await verifyWebAssets(path.join(packagedResourcesPath(context), "web"));
  await signEngine(context, engineDir);
  await flipFuses(electronBinaryPath(context), {
    version: FuseVersion.V1,
    // Disable the "run this app as a plain Node process" vector: without it,
    // `ELECTRON_RUN_AS_NODE=1 ./Homun` gives a Node REPL with full fs/network
    // access under the app's identity.
    [FuseV1Options.RunAsNode]: false,
    // Disable --inspect/--inspect-brk: no attaching a debugger to the packaged
    // main process to run arbitrary code in-process.
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // Ignore NODE_OPTIONS in the packaged app (another arbitrary-flag vector).
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    // Encrypt cookies at rest (safeStorage-backed) instead of plaintext on disk.
    [FuseV1Options.EnableCookieEncryption]: true,
    // Only load app code from the asar archive — not a loose, swappable dir.
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // macOS: after rewriting the binary, drop the invalidated ad-hoc signature
    // so electron-builder's real signing step starts from a clean slate.
    resetAdHocDarwinSignature: context.electronPlatformName === "darwin",
  });
}
