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
import path from "node:path";

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
}
