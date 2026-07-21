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

export function assertExactArchitecture(output, expectedArchitecture, label) {
  const architectures = String(output).trim().split(/\s+/).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== expectedArchitecture) {
    throw new Error(
      `${label} architecture mismatch: expected exactly ${expectedArchitecture}, got ${architectures.join(" ") || "none"}`,
    );
  }
  return architectures;
}

export function verifyHostComputerPackage({
  appPath,
  requireNotarization = true,
  expectedArchitecture = "arm64",
}) {
  const app = resolve(appPath);
  const helper = `${app}/Contents/Resources/host-computer/HomunComputerService.app`;
  const helperExecutable = `${helper}/Contents/MacOS/HomunComputerService`;
  const gatewayExecutable = `${app}/Contents/Resources/bin/local-first-desktop-gateway`;
  if (!existsSync(helperExecutable)) throw new Error(`Host helper is missing: ${helperExecutable}`);
  if (!existsSync(gatewayExecutable)) throw new Error(`Desktop gateway is missing: ${gatewayExecutable}`);

  const commands = verificationCommandPlan(app).filter(([command, args]) =>
    requireNotarization || !(command === "xcrun" && args[0] === "stapler")
  );
  const commandOutputs = commands.map(([command, args]) => ({
    command,
    args,
    output: run(command, args),
  }));

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
  const architectureOutput = (executable) => commandOutputs.find(
    ({ command, args }) => command === "lipo" && args.at(-1) === executable,
  )?.output ?? "";
  const helperArchitectures = assertExactArchitecture(
    architectureOutput(helperExecutable),
    expectedArchitecture,
    "Host helper",
  );
  const gatewayArchitectures = assertExactArchitecture(
    architectureOutput(gatewayExecutable),
    expectedArchitecture,
    "Desktop gateway",
  );
  return {
    app,
    helper,
    teamIdentifier: appTeam,
    helperArchitectures,
    gatewayArchitectures,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appIndex = process.argv.indexOf("--app");
  if (appIndex < 0 || !process.argv[appIndex + 1]) throw new Error("Usage: --app <Homun.app>");
  const architectureIndex = process.argv.indexOf("--expected-arch");
  const result = verifyHostComputerPackage({
    appPath: process.argv[appIndex + 1],
    requireNotarization: !process.argv.includes("--skip-notarization"),
    expectedArchitecture: architectureIndex >= 0
      ? process.argv[architectureIndex + 1]
      : "arm64",
  });
  process.stdout.write(
    `Verified host helper at ${result.helper}\nTeam: ${result.teamIdentifier}\n` +
    `Helper architecture: ${result.helperArchitectures.join(", ")}\n` +
    `Gateway architecture: ${result.gatewayArchitectures.join(", ")}\n`,
  );
}
