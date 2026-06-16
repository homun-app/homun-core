import { spawnSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, cpSync, chmodSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(appRoot, "../..");
const resourcesDir = resolve(
  process.env.HOMUN_DESKTOP_PACKAGE_RESOURCES ??
    join(appRoot, ".package", "resources"),
);
const skipBuild = process.argv.includes("--skip-build");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    // On Windows `npm`/`cargo` are `npm.cmd`/`cargo.exe`; without a shell
    // spawnSync can't resolve them (PATHEXT) and fails with status: null.
    shell: process.platform === "win32",
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

// Stage the contained-computer build context so the packaged app can start the
// agent's browser/sandbox. up.sh builds the image from THIS directory; the
// gateway is pointed at the staged up.sh via HOMUN_CONTAINED_COMPUTER_UP (see
// main.cjs). Without this the "local computer" can't start on an installed
// desktop app — up_script() only finds repo-relative paths absent from the bundle.
const ccSource = join(repoRoot, "runtimes", "contained-computer");
const ccTarget = join(resourcesDir, "contained-computer");
if (!existsSync(ccSource)) {
  throw new Error(`Contained-computer context not found: ${ccSource}`);
}
cpSync(ccSource, ccTarget, { recursive: true });
chmodSync(join(ccTarget, "up.sh"), 0o755);

// Stage the bundled default skills (HomunCoder methodology) so a fresh install
// ships them. The gateway seeds them into ~/.homun/skills on first run, pointed
// here via HOMUN_DEFAULT_SKILLS_DIR (see main.cjs). Snapshot lives in the repo
// (resources/default-skills); re-vendor with scripts/vendor-default-skills.sh.
const skillsSource = join(repoRoot, "resources", "default-skills");
const skillsTarget = join(resourcesDir, "default-skills");
if (existsSync(skillsSource)) {
  cpSync(skillsSource, skillsTarget, { recursive: true });
}

console.log(`Prepared Electron resources at ${resourcesDir}`);
console.log(`Gateway: ${relative(repoRoot, gatewayTarget)}`);
console.log(`Contained computer: ${relative(repoRoot, ccTarget)}`);
if (existsSync(skillsTarget)) {
  console.log(`Default skills: ${relative(repoRoot, skillsTarget)}`);
}
