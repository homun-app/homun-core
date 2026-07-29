import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");
const modulePath = path.join(appRoot, "scripts", "license-compliance.mjs");
const expectedLicenseSha256 =
  "5904c160d2d93c62e0113b5cc9d20a6880e04839bff3a130bd622cc141a64429";

async function loadModule(t) {
  if (!existsSync(modulePath)) {
    t.skip("license-compliance.mjs does not exist yet");
    return null;
  }
  return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
}

async function write(target, contents) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "homun-license-test-"));
  const fixtureRepo = path.join(root, "repo");
  const fixtureApp = path.join(fixtureRepo, "apps", "desktop");
  const resourcesDir = path.join(root, "Resources");
  await mkdir(fixtureApp, { recursive: true });
  await cp(path.join(repoRoot, "LICENSE.md"), path.join(fixtureRepo, "LICENSE.md"));
  await write(path.join(fixtureApp, "node_modules", "electron", "LICENSE"), "Electron MIT\n");
  await write(
    path.join(
      fixtureApp,
      "node_modules",
      "electron",
      "dist",
      "LICENSES.chromium.html",
    ),
    "<html>Chromium notices</html>\n",
  );
  await write(
    path.join(fixtureRepo, "runtimes", "contained-computer", "fonts", "THIRD_PARTY_NOTICES.md"),
    "# Font notices\n\n| Family | Package | Version | License |\n| --- | --- | --- | --- |\n| Inter | @fontsource/inter | 5.2.8 | OFL-1.1 |\n",
  );
  await write(
    path.join(fixtureRepo, "runtimes", "contained-computer", "fonts", "LICENSE_MANIFEST.json"),
    `${JSON.stringify(
      {
        fonts: [
          {
            family: "Inter",
            package: "@fontsource/inter",
            version: "5.2.8",
            license: "OFL-1.1",
            fontFiles: ["inter-400.woff2", "inter-700.woff2"],
            licenseFiles: ["licenses/inter/LICENSE"],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await write(
    path.join(fixtureRepo, "runtimes", "contained-computer", "fonts", "inter-400.woff2"),
    "font-400",
  );
  await write(
    path.join(fixtureRepo, "runtimes", "contained-computer", "fonts", "inter-700.woff2"),
    "font-700",
  );
  await write(
    path.join(
      fixtureRepo,
      "runtimes",
      "contained-computer",
      "fonts",
      "licenses",
      "inter",
      "LICENSE",
    ),
    "OFL font license\n",
  );
  await write(
    path.join(fixtureRepo, "resources", "default-skills", "LICENSE.md"),
    "MIT License for skills\n",
  );
  await write(
    path.join(fixtureRepo, "compliance", "python-runtime.json"),
    `${JSON.stringify(
      {
        packages: [
          {
            name: "demo-python",
            version: "1.0.0",
            license: "MIT",
            source: "https://example.test/demo-python",
            distribution: "installed-when-container-is-built",
          },
        ],
        model: {
          name: "demo-model",
          license: "MIT",
          source: "https://example.test/demo-model",
          distribution: "downloaded-at-runtime",
        },
      },
      null,
      2,
    )}\n`,
  );
  await write(
    path.join(fixtureRepo, "compliance", "licenses", "LLVM-exception.txt"),
    "LLVM exception text\n",
  );

  const npmSource = path.join(fixtureApp, "node_modules", "demo-package");
  await write(
    path.join(npmSource, "package.json"),
    `${JSON.stringify({ name: "demo-package", version: "2.0.0", license: "MIT" })}\n`,
  );
  await write(path.join(npmSource, "NOTICE"), "Package-specific npm notice\n");

  const cargoSource = path.join(root, "cargo", "demo-crate");
  await write(path.join(cargoSource, "Cargo.toml"), "[package]\nname='demo-crate'\n");

  return {
    root,
    fixtureRepo,
    fixtureApp,
    resourcesDir,
    npmPackages: [
      {
        ecosystem: "npm",
        name: "demo-package",
        version: "2.0.0",
        license: "MIT",
        sourceDir: npmSource,
      },
    ],
    cargoPackages: [
      {
        ecosystem: "cargo",
        name: "demo-crate",
        version: "1.2.3",
        license: "Apache-2.0 WITH LLVM-exception",
        authors: ["Demo Author"],
        repository: "https://example.test/demo-crate",
        sourceDir: cargoSource,
      },
    ],
  };
}

function optionsFor(fixture, overrides = {}) {
  return {
    repoRoot: fixture.fixtureRepo,
    appRoot: fixture.fixtureApp,
    resourcesDir: fixture.resourcesDir,
    npmPackages: fixture.npmPackages,
    cargoPackages: fixture.cargoPackages,
    expectedLicenseSha256,
    ...overrides,
  };
}

test("license compliance staging module exists", () => {
  assert.equal(existsSync(modulePath), true);
});

test("package preparation installs Electron notices before compliance staging", async () => {
  const source = await readFile(
    path.join(appRoot, "scripts", "prepare-package.mjs"),
    "utf8",
  );
  const installIndex = source.indexOf('node_modules", "electron", "install.js');
  const stageIndex = source.lastIndexOf("stageLicenseCompliance");
  assert.ok(installIndex >= 0, "Electron's lazy binary installer must be invoked");
  assert.ok(installIndex < stageIndex, "Electron notices must exist before staging");
  assert.match(
    source,
    /stageLicenseCompliance\(\{ repoRoot, resourcesDir \}\)/,
    "the environment-selected resources directory must receive the compliance bundle",
  );
});

test("Cargo dependency discovery is locked and offline", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.match(
    source,
    /\["metadata", "--locked", "--offline", "--format-version"/,
  );
});

test("npm lock discovery falls back to installed package metadata", async (t) => {
  const compliance = await loadModule(t);
  if (!compliance) return;
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const lock = {
    packages: {
      "": { name: "root", version: "1.0.0" },
      "node_modules/demo-package": { version: "2.0.0" },
      "node_modules/dev-only": { version: "1.0.0", license: "MIT", dev: true },
    },
  };

  const packages = compliance.packagesFromNpmLock(lock, fixture.fixtureApp);

  assert.deepEqual(
    packages.map(({ name, version, license }) => ({ name, version, license })),
    [{ name: "demo-package", version: "2.0.0", license: "MIT" }],
  );
});

test("npm license overrides are explicit and tied to bundled legal files", async (t) => {
  const compliance = await loadModule(t);
  if (!compliance) return;
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const packageJson = path.join(
    fixture.fixtureApp,
    "node_modules",
    "demo-package",
    "package.json",
  );
  await write(packageJson, `${JSON.stringify({ name: "demo-package", version: "2.0.0" })}\n`);
  const lock = {
    packages: {
      "node_modules/demo-package": { version: "2.0.0" },
    },
  };

  const packages = compliance.packagesFromNpmLock(
    lock,
    fixture.fixtureApp,
    { "demo-package@2.0.0": "MIT" },
  );

  assert.equal(packages[0].license, "MIT");
  assert.equal(packages[0].licenseOverride, true);
});

test("Cargo discovery excludes workspace packages and sorts dependencies", async (t) => {
  const compliance = await loadModule(t);
  if (!compliance) return;
  const metadata = {
    workspace_members: ["workspace 0.1.0"],
    packages: [
      {
        id: "zeta 1.0.0",
        name: "zeta",
        version: "1.0.0",
        license: "MIT",
        authors: [],
        repository: null,
        manifest_path: "/tmp/zeta/Cargo.toml",
      },
      {
        id: "workspace 0.1.0",
        name: "workspace",
        version: "0.1.0",
        license: "FSL-1.1-ALv2",
        manifest_path: "/tmp/workspace/Cargo.toml",
      },
      {
        id: "alpha 1.0.0",
        name: "alpha",
        version: "1.0.0",
        license: "Apache-2.0",
        authors: [],
        repository: null,
        manifest_path: "/tmp/alpha/Cargo.toml",
      },
    ],
  };

  assert.deepEqual(
    compliance.packagesFromCargoMetadata(metadata).map(({ name }) => name),
    ["alpha", "zeta"],
  );
});

test("SPDX expressions preserve alternatives and exceptions", async (t) => {
  const compliance = await loadModule(t);
  if (!compliance) return;
  assert.deepEqual(
    compliance.licenseIds("(MIT/Apache-2.0) AND Apache-2.0 WITH LLVM-exception"),
    {
      ids: ["Apache-2.0", "MIT"],
      exceptions: ["LLVM-exception"],
    },
  );
});

test("stages a deterministic complete compliance bundle", async (t) => {
  const compliance = await loadModule(t);
  if (!compliance) return;
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await compliance.stageLicenseCompliance(optionsFor(fixture));

  assert.equal(
    await readFile(path.join(fixture.resourcesDir, "LICENSE.md"), "utf8"),
    await readFile(path.join(fixture.fixtureRepo, "LICENSE.md"), "utf8"),
  );
  const notice = await readFile(
    path.join(fixture.resourcesDir, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  assert.match(notice, /demo-crate \| 1\.2\.3 \| Apache-2\.0 WITH LLVM-exception/);
  assert.match(notice, /demo-package \| 2\.0\.0 \| MIT/);
  assert.ok(notice.indexOf("demo-crate") < notice.indexOf("demo-package"));
  assert.equal(
    await readFile(
      path.join(
        fixture.resourcesDir,
        "third-party-licenses",
        "npm",
        "demo-package@2.0.0",
        "NOTICE",
      ),
      "utf8",
    ),
    "Package-specific npm notice\n",
  );
  assert.match(
    await readFile(
      path.join(
        fixture.resourcesDir,
        "third-party-licenses",
        "spdx",
        "MIT.txt",
      ),
      "utf8",
    ),
    /^MIT License/,
  );
  assert.equal(
    await readFile(
      path.join(
        fixture.resourcesDir,
        "third-party-licenses",
        "exceptions",
        "LLVM-exception.txt",
      ),
      "utf8",
    ),
    "LLVM exception text\n",
  );
  for (const relativePath of [
    "third-party-licenses/electron/LICENSE",
    "third-party-licenses/electron/LICENSES.chromium.html",
    "third-party-licenses/fonts/THIRD_PARTY_NOTICES.md",
    "third-party-licenses/fonts/LICENSE_MANIFEST.json",
    "third-party-licenses/fonts/licenses/inter/LICENSE",
    "third-party-licenses/default-skills/LICENSE.md",
    "third-party-licenses/python-runtime/inventory.json",
    "third-party-licenses/python-runtime/NOTICE.md",
  ]) {
    assert.equal(
      existsSync(path.join(fixture.resourcesDir, relativePath)),
      true,
      `${relativePath} must be staged`,
    );
  }
});

test("rejects a product license whose canonical hash changed", async (t) => {
  const compliance = await loadModule(t);
  if (!compliance) return;
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await write(path.join(fixture.fixtureRepo, "LICENSE.md"), "changed license\n");

  await assert.rejects(
    () => compliance.stageLicenseCompliance(optionsFor(fixture)),
    /canonical product license SHA-256 mismatch/,
  );
});

test("rejects unknown dependency licenses", async (t) => {
  const compliance = await loadModule(t);
  if (!compliance) return;
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      compliance.stageLicenseCompliance(
        optionsFor(fixture, {
          npmPackages: [
            {
              ...fixture.npmPackages[0],
              license: "UNKNOWN",
            },
          ],
        }),
      ),
    /Unknown license.*demo-package/,
  );
});

test("rejects missing Electron or Chromium notices", async (t) => {
  const compliance = await loadModule(t);
  if (!compliance) return;
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await rm(
    path.join(
      fixture.fixtureApp,
      "node_modules",
      "electron",
      "dist",
      "LICENSES.chromium.html",
    ),
  );

  await assert.rejects(
    () => compliance.stageLicenseCompliance(optionsFor(fixture)),
    /Electron\/Chromium notice is missing.*LICENSES\.chromium\.html/,
  );
});

test("rejects a shipped font that is absent from the license manifest", async (t) => {
  const compliance = await loadModule(t);
  if (!compliance) return;
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await write(
    path.join(
      fixture.fixtureRepo,
      "runtimes",
      "contained-computer",
      "fonts",
      "untracked-400.woff2",
    ),
    "untracked font",
  );

  await assert.rejects(
    () => compliance.stageLicenseCompliance(optionsFor(fixture)),
    /font license manifest does not cover shipped files.*untracked-400\.woff2/i,
  );
});

test("rejects a font manifest whose declared legal file is missing", async (t) => {
  const compliance = await loadModule(t);
  if (!compliance) return;
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await rm(
    path.join(
      fixture.fixtureRepo,
      "runtimes",
      "contained-computer",
      "fonts",
      "licenses",
      "inter",
      "LICENSE",
    ),
  );

  await assert.rejects(
    () => compliance.stageLicenseCompliance(optionsFor(fixture)),
    /font legal file.*licenses\/inter\/LICENSE.*missing/i,
  );
});
