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
  // Channel bridges are standalone Cargo projects (deliberately NOT in the root
  // workspace, so the gateway build stays fast), so build each in its own dir.
  for (const bridge of ["channel-telegram", "channel-whatsapp"]) {
    run("cargo", ["build", "--release"], join(repoRoot, "runtimes", bridge));
  }
  // The browser-automation sidecar (Node/Playwright) runs from source via
  // `npm run start` (tsx src/server.ts). Install its deps per-platform so the
  // bundled node_modules (esbuild/tsx native bits) match the target OS.
  run("npm", ["ci"], join(repoRoot, "runtimes", "browser-automation"));
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

// Stage the channel bridge sidecars next to the gateway so connecting a channel
// works from an installed app. The gateway is pointed at each staged binary via
// HOMUN_TELEGRAM_BIN / HOMUN_WHATSAPP_BIN (see main.cjs). Without this, channel
// connect fails with `telegram_bin_missing` / `whatsapp_bin_missing` because the
// gateway only finds repo-relative paths absent from the bundle.
const bridgeExe = process.platform === "win32" ? ".exe" : "";
const stagedBridges = [];
for (const bridge of ["channel-telegram", "channel-whatsapp"]) {
  const bridgeSource = join(repoRoot, "runtimes", bridge, "target", "release", `${bridge}${bridgeExe}`);
  if (!existsSync(bridgeSource)) {
    throw new Error(`Channel bridge binary not found: ${bridgeSource}`);
  }
  const bridgeTarget = join(resourcesDir, "bin", `${bridge}${bridgeExe}`);
  cpSync(bridgeSource, bridgeTarget);
  chmodSync(bridgeTarget, 0o755);
  stagedBridges.push(relative(repoRoot, bridgeTarget));
}

// Stage the browser-automation sidecar (Node/Playwright) that drives the
// contained-computer browser over CDP. The gateway runs `npm run start`
// (tsx src/server.ts) in this dir, pointed here via HOMUN_BROWSER_AUTOMATION_DIR
// (see main.cjs). Without it the gateway only finds the repo-relative path
// (absent from the bundle) and the browser is "unreachable" from an installed app.
const baSource = join(repoRoot, "runtimes", "browser-automation");
const baTarget = join(resourcesDir, "browser-automation");
for (const entry of ["package.json", "src", "node_modules"]) {
  const from = join(baSource, entry);
  if (!existsSync(from)) {
    throw new Error(
      `Browser-automation entry not found: ${from} (run \`npm ci\` in runtimes/browser-automation)`,
    );
  }
  cpSync(from, join(baTarget, entry), { recursive: true });
}
for (const entry of ["tsconfig.json", "package-lock.json"]) {
  const from = join(baSource, entry);
  if (existsSync(from)) cpSync(from, join(baTarget, entry));
}

console.log(`Prepared Electron resources at ${resourcesDir}`);
console.log(`Gateway: ${relative(repoRoot, gatewayTarget)}`);
console.log(`Contained computer: ${relative(repoRoot, ccTarget)}`);
if (existsSync(skillsTarget)) {
  console.log(`Default skills: ${relative(repoRoot, skillsTarget)}`);
}
for (const bridge of stagedBridges) {
  console.log(`Channel bridge: ${bridge}`);
}
console.log(`Browser automation: ${relative(repoRoot, baTarget)}`);
