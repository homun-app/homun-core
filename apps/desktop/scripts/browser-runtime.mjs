import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(appRoot, "../..");

function runNpm(args, cwd) {
  let executable = "npm";
  let executableArgs = args;
  if (process.platform === "win32") {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) {
      throw new Error("npm_execpath is required to invoke npm safely on Windows");
    }
    executable = process.execPath;
    executableArgs = [npmCli, ...args];
  }
  const result = spawnSync(executable, executableArgs, {
    cwd,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${executable} ${executableArgs.join(" ")} failed with ${result.status}`);
  }
}

export function browserAutomationRuntimeDir() {
  return resolve(repoRoot, "runtimes", "browser-automation");
}

export function browserAutomationEntrypoint(runtimeDir = browserAutomationRuntimeDir()) {
  return join(runtimeDir, "node_modules", "tsx", "dist", "cli.mjs");
}

export function ensureDevBrowserAutomationRuntime() {
  const runtimeDir = process.env.HOMUN_BROWSER_AUTOMATION_DIR
    ? resolve(process.env.HOMUN_BROWSER_AUTOMATION_DIR)
    : browserAutomationRuntimeDir();
  const packageLock = join(runtimeDir, "package-lock.json");
  if (!existsSync(packageLock)) {
    throw new Error(`Browser automation runtime not found: ${runtimeDir}`);
  }
  if (!existsSync(browserAutomationEntrypoint(runtimeDir))) {
    console.log(`Installing browser automation runtime dependencies in ${runtimeDir}`);
    runNpm(["ci"], runtimeDir);
  }
  if (!existsSync(browserAutomationEntrypoint(runtimeDir))) {
    throw new Error(
      `Browser automation runtime is missing ${browserAutomationEntrypoint(runtimeDir)}`,
    );
  }
  return runtimeDir;
}
