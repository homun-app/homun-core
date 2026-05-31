import { spawnSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, cpSync, chmodSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(appRoot, "../..");
const resourcesDir = resolve(
  process.env.LOCAL_FIRST_DESKTOP_PACKAGE_RESOURCES ??
    join(appRoot, ".package", "resources"),
);
const skipBuild = process.argv.includes("--skip-build");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
}

if (!skipBuild) {
  run("npm", ["run", "build"], appRoot);
  run("cargo", ["build", "-p", "local-first-desktop-gateway", "--release"], repoRoot);
}

rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(join(resourcesDir, "bin"), { recursive: true });

const executable = process.platform === "win32"
  ? "local-first-desktop-gateway.exe"
  : "local-first-desktop-gateway";
const gatewaySource = join(repoRoot, "target", "release", executable);
const gatewayTarget = join(resourcesDir, "bin", executable);
if (!existsSync(gatewaySource)) {
  throw new Error(`Gateway release binary not found: ${gatewaySource}`);
}
cpSync(gatewaySource, gatewayTarget);
chmodSync(gatewayTarget, 0o755);

console.log(`Prepared Electron resources at ${resourcesDir}`);
console.log(`Gateway: ${relative(repoRoot, gatewayTarget)}`);
