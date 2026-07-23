import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");

async function readOptional(relativePath) {
  try {
    return await readFile(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

test("Python runtime entry points are pinned to audited versions", async () => {
  assert.equal(
    await readOptional("runtimes/contained-computer/requirements-whisper.txt"),
    "faster-whisper==1.2.1\n",
  );
  assert.equal(
    await readOptional("runtimes/contained-computer/requirements-deck.txt"),
    "python-pptx==1.0.2\n",
  );
  assert.equal(
    await readOptional("runtimes/graphify/requirements.txt"),
    "graphifyy==0.9.25\n",
  );
});

test("Docker runtime builds install only through the pinned requirement files", async () => {
  const contained = await readOptional("runtimes/contained-computer/Dockerfile");
  const graphify = await readOptional("runtimes/graphify/Dockerfile");

  assert.match(contained, /COPY requirements-whisper\.txt \/tmp\/requirements-whisper\.txt/);
  assert.match(contained, /pip install --no-cache-dir -r \/tmp\/requirements-whisper\.txt/);
  assert.match(contained, /COPY requirements-deck\.txt \/tmp\/requirements-deck\.txt/);
  assert.match(contained, /pip install --no-cache-dir -r \/tmp\/requirements-deck\.txt/);
  assert.doesNotMatch(contained, /pip install --no-cache-dir faster-whisper/);
  assert.doesNotMatch(contained, /pip install --no-cache-dir python-pptx/);

  assert.match(graphify, /COPY requirements\.txt \/tmp\/requirements\.txt/);
  assert.match(graphify, /pip install --no-cache-dir -r \/tmp\/requirements\.txt/);
  assert.doesNotMatch(graphify, /pip install --no-cache-dir graphifyy/);
});

test("runtime license inventory distinguishes packaged inputs from runtime downloads", async () => {
  const raw = await readOptional("compliance/python-runtime.json");
  assert.notEqual(raw, null, "compliance/python-runtime.json must exist");
  const inventory = JSON.parse(raw);

  assert.deepEqual(inventory.packages, [
    {
      name: "faster-whisper",
      version: "1.2.1",
      source: "https://pypi.org/project/faster-whisper/1.2.1/",
      license: "MIT",
      distribution: "installed-when-container-is-built",
    },
    {
      name: "graphifyy",
      version: "0.9.25",
      source: "https://pypi.org/project/graphifyy/0.9.25/",
      license: "MIT",
      distribution: "installed-when-container-is-built",
    },
    {
      name: "python-pptx",
      version: "1.0.2",
      source: "https://pypi.org/project/python-pptx/1.0.2/",
      license: "MIT",
      distribution: "installed-when-container-is-built",
    },
  ]);
  assert.deepEqual(inventory.model, {
    name: "faster-whisper-large-v3-turbo",
    source: "https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo",
    license: "MIT",
    distribution: "downloaded-at-runtime",
  });
});

test("vendored default skills retain their MIT license across refreshes", async () => {
  const license = await readOptional("resources/default-skills/LICENSE.md");
  const vendorScript = await readOptional("scripts/vendor-default-skills.sh");

  assert.notEqual(license, null, "resources/default-skills/LICENSE.md must exist");
  assert.match(license, /^MIT License$/m);
  assert.match(license, /Copyright \(c\) 2026 Fabio/);
  assert.match(vendorScript, /LICENSE\.md/);
  assert.match(vendorScript, /mktemp/);
  assert.ok(
    vendorScript.indexOf("LICENSE.md") < vendorScript.indexOf('rm -rf "$DEST"'),
    "the vendor script must preserve the notice before replacing the snapshot",
  );
});
