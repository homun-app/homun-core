import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");

test("packaged contained computer uses native gateway bootstrap", async () => {
  const prepare = await readFile(
    path.join(appRoot, "scripts", "prepare-package.mjs"),
    "utf8",
  );
  const sandbox = await readFile(
    path.join(repoRoot, "crates", "desktop-gateway", "src", "sandbox.rs"),
    "utf8",
  );
  assert.match(prepare, /contained-computer/);
  assert.match(sandbox, /build_contained_computer_image/);
  assert.doesNotMatch(sandbox, /Command::new\("bash"\).*up_script/s);
});

test("chat noVNC viewer remains executable under the packaged Electron CSP", async () => {
  const viewer = await readFile(
    path.join(repoRoot, "runtimes", "contained-computer", "novnc-view.html"),
    "utf8",
  );
  const dockerfile = await readFile(
    path.join(repoRoot, "runtimes", "contained-computer", "Dockerfile"),
    "utf8",
  );
  const launcher = await readFile(
    path.join(repoRoot, "runtimes", "contained-computer", "up.sh"),
    "utf8",
  );

  assert.doesNotMatch(
    viewer,
    /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i,
    "the packaged CSP blocks inline scripts in the iframe response",
  );
  assert.match(viewer, /<script type="module" src="\.\/lfpa-view\.js"><\/script>/);
  assert.match(dockerfile, /COPY novnc-view\.js \/usr\/share\/novnc\/lfpa-view\.js/);
  assert.match(launcher, /HASH_FILES="[^"]*novnc-view\.js[^"]*"/);

  const viewerModule = await readFile(
    path.join(repoRoot, "runtimes", "contained-computer", "novnc-view.js"),
    "utf8",
  );
  assert.match(viewerModule, /import RFB from ['"]\.\/core\/rfb\.js['"]/);
  assert.match(viewerModule, /homun-novnc-state/);
  assert.match(viewerModule, /publish\(['"]connected['"]\)/);
  assert.match(viewerModule, /publish\(['"]connecting['"]\)/);

  const chatPanel = await readFile(
    path.join(appRoot, "src", "components", "ChatComputerPanel.tsx"),
    "utf8",
  );
  const computerView = await readFile(
    path.join(appRoot, "src", "components", "ContainedComputerView.tsx"),
    "utf8",
  );
  const settingsView = await readFile(
    path.join(appRoot, "src", "components", "SettingsView.tsx"),
    "utf8",
  );
  for (const component of [chatPanel, computerView, settingsView]) {
    assert.match(component, /homun-novnc-state/);
    assert.match(component, /event\.source !== iframeRef\.current\?\.contentWindow/);
    assert.match(component, /event\.origin !== expectedOrigin/);
  }
  assert.match(chatPanel, /computerConnectionState === "connected"/);
  assert.match(settingsView, /replace\("\/vnc\.html", "\/lfpa-view\.html"\)/);
  assert.doesNotMatch(settingsView, /<iframe className="set-computer-live-frame" src=\{liveUrl\}/);
});

test("architecture documents the cross-platform setup contract", async () => {
  const architecture = await readFile(
    path.join(repoRoot, "docs", "architecture", "contained-computer.md"),
    "utf8",
  );
  assert.match(architecture, /`POST \/api\/setup\/computer\/prepare`/);
  assert.match(architecture, /Windows, macOS, and Linux/);
  assert.match(architecture, /CDP.*noVNC/s);
});
