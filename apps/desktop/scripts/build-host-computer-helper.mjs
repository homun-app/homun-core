import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const appRoot = dirname(dirname(scriptPath));
const repoRoot = resolve(appRoot, "../..");
const packageRoot = join(repoRoot, "runtimes", "host-computer", "macos");
const plistSource = join(
  appRoot,
  "resources",
  "host-computer",
  "HomunComputerService-Info.plist",
);

export function hostComputerStagingPlan(platform = process.platform) {
  if (platform !== "darwin") return null;
  return { relativeBundlePath: "host-computer/HomunComputerService.app" };
}

export async function buildHostComputerHelper({
  configuration = "release",
  outputDir = join(appRoot, ".package", "host-computer-build"),
} = {}) {
  if (!new Set(["debug", "release"]).has(configuration)) {
    throw new Error(`Unsupported Swift configuration: ${configuration}`);
  }

  runSwift(["build", "--package-path", packageRoot, "--configuration", configuration, "--product", "HomunComputerService"]);
  const binPath = runSwift([
    "build",
    "--package-path",
    packageRoot,
    "--configuration",
    configuration,
    "--show-bin-path",
  ]).trim();
  const sourceExecutable = join(binPath, "HomunComputerService");
  const bundle = join(outputDir, "HomunComputerService.app");
  const contents = join(bundle, "Contents");
  const executable = join(contents, "MacOS", "HomunComputerService");
  const infoPlist = join(contents, "Info.plist");

  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  copyFileSync(sourceExecutable, executable);
  chmodSync(executable, 0o755);
  copyFileSync(plistSource, infoPlist);

  return {
    bundle,
    executable,
    infoPlist,
    info: {
      CFBundleIdentifier: "app.homun.desktop.computer-service",
      CFBundleExecutable: "HomunComputerService",
      LSUIElement: true,
      LSMinimumSystemVersion: "14.0",
      NSAccessibilityUsageDescription:
        "Homun uses Accessibility to observe and control only the Mac apps you explicitly approve.",
      NSScreenCaptureUsageDescription:
        "Homun captures only approved app windows so you can inspect and supervise computer use.",
    },
  };
}

function runSwift(args) {
  const result = spawnSync("swift", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`swift ${args.join(" ")} failed with ${result.status}`);
  }
  return result.stdout;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const configuration = process.argv.includes("--debug") ? "debug" : "release";
  const result = await buildHostComputerHelper({ configuration });
  process.stdout.write(`${result.bundle}\n`);
}
