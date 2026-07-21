// electron-builder `afterPack` hook: flip Electron fuses to close well-known
// escape vectors in the packaged app (P1 hardening, docs/confronto-codex-produzione.md §5).
//
// WHY here (afterPack, not afterSign): flipping fuses rewrites the Electron
// binary, which invalidates any code signature — so it MUST happen before
// electron-builder signs. afterPack runs at exactly that point. On macOS we
// reset the ad-hoc signature so the subsequent real signing starts clean.
//
// Verified end-to-end only in a real `electron-builder` build (not package:smoke,
// which runs raw electron and never invokes afterPack).
import { FuseVersion, FuseV1Options, flipFuses } from "@electron/fuses";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeveloperIdIdentity } from "./host-computer-signing.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

async function signHostComputerHelper(context) {
  if (context.electronPlatformName !== "darwin" || process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return;
  const appName = context.packager.appInfo.productFilename;
  const helper = path.join(context.appOutDir, `${appName}.app`, "Contents", "Resources", "host-computer", "HomunComputerService.app");
  if (!existsSync(helper)) throw new Error(`Nested host helper is missing before signing: ${helper}`);
  const executable = path.join(helper, "Contents", "MacOS", "HomunComputerService");
  const entitlements = path.resolve(scriptDir, "../resources/host-computer/entitlements.mac.plist");
  // Force electron-builder to import CSC_LINK into its temporary keychain before
  // asking `security` for the resolved Developer ID identity.
  await context.packager.codeSigningInfo?.value;
  const identity = process.env.CSC_NAME || parseDeveloperIdIdentity(run("security", ["find-identity", "-v", "-p", "codesigning"]));
  if (!identity) {
    // Non-release local builds often have no signing certificate. electron-builder
    // will make the same decision for the outer app; the signed release CI refuses
    // to publish before reaching this hook when credentials are absent.
    return;
  }
  const common = ["--force", "--sign", identity, "--options", "runtime", "--timestamp", "--entitlements", entitlements];
  run("codesign", [...common, executable]);
  run("codesign", [...common, helper]);
}

/** Resolve the packaged Electron executable per platform. */
function electronBinaryPath(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const exeName = packager.appInfo.productFilename; // e.g. "Homun"
  if (electronPlatformName === "darwin") {
    // The fuse-carrying binary is the app's MacOS executable (executableName).
    const macExe = packager.platformSpecificBuildOptions.executableName ?? exeName;
    return path.join(appOutDir, `${exeName}.app`, "Contents", "MacOS", macExe);
  }
  if (electronPlatformName === "win32") {
    return path.join(appOutDir, `${exeName}.exe`);
  }
  // linux
  const linExe = packager.platformSpecificBuildOptions.executableName ?? exeName;
  return path.join(appOutDir, linExe);
}

export default async function afterPack(context) {
  const electronBinary = electronBinaryPath(context);
  await flipFuses(electronBinary, {
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
  // Sign the isolated nested helper with its own empty, least-privilege
  // entitlement set. mac.signIgnore preserves this signature; electron-builder
  // then signs Electron's helpers and finally the outer app, which seals it.
  await signHostComputerHelper(context);
}
