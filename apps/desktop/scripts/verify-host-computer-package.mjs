import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { forbiddenHelperEntitlements, verificationCommandPlan } from "./host-computer-signing.mjs";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function verifyHostComputerPackage({ appPath, requireNotarization = true, requireUniversal = false }) {
  const app = resolve(appPath);
  const helper = `${app}/Contents/Resources/host-computer/HomunComputerService.app`;
  const helperExecutable = `${helper}/Contents/MacOS/HomunComputerService`;
  if (!existsSync(helperExecutable)) throw new Error(`Host helper is missing: ${helperExecutable}`);

  const commands = verificationCommandPlan(app).filter(([command, args]) =>
    requireNotarization || !(command === "xcrun" && args[0] === "stapler")
  );
  for (const [command, args] of commands) run(command, args);

  const appSignature = run("codesign", ["-dv", "--verbose=4", app]);
  const helperSignature = run("codesign", ["-dv", "--verbose=4", helper]);
  const appTeam = appSignature.match(/TeamIdentifier=([^\s]+)/)?.[1];
  const helperTeam = helperSignature.match(/TeamIdentifier=([^\s]+)/)?.[1];
  if (!appTeam || appTeam === "not set" || appTeam !== helperTeam) {
    throw new Error(`Nested helper team does not match outer app (${helperTeam ?? "missing"} vs ${appTeam ?? "missing"})`);
  }

  const entitlements = run("codesign", ["-d", "--entitlements", ":-", helper]);
  for (const forbidden of forbiddenHelperEntitlements) {
    if (entitlements.includes(`<key>${forbidden}</key>`)) {
      throw new Error(`Forbidden helper entitlement: ${forbidden}`);
    }
  }
  const helperArchitectures = run("lipo", ["-archs", helperExecutable]).trim().split(/\s+/);
  if (requireUniversal && !(helperArchitectures.includes("arm64") && helperArchitectures.includes("x86_64"))) {
    throw new Error(`Host helper is not universal: ${helperArchitectures.join(" ")}`);
  }
  return { app, helper, teamIdentifier: appTeam, helperArchitectures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appIndex = process.argv.indexOf("--app");
  if (appIndex < 0 || !process.argv[appIndex + 1]) throw new Error("Usage: --app <Homun.app>");
  const result = verifyHostComputerPackage({
    appPath: process.argv[appIndex + 1],
    requireNotarization: !process.argv.includes("--skip-notarization"),
    requireUniversal: process.argv.includes("--require-universal"),
  });
  process.stdout.write(`Verified host helper at ${result.helper}\nTeam: ${result.teamIdentifier}\nArchitectures: ${result.helperArchitectures.join(", ")}\n`);
}
