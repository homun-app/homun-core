import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadEngineMaterialLibrary,
  uploadEngineMaterialFiles,
  archiveLibraryMaterial,
} from "../apps/web/src/lib/engine-material-library.ts";
import { subscribeMaterialChanges } from "../apps/web/src/lib/project-materials-lifecycle.ts";

test("library reads the engine projects and never creates data during a read", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method} ${input}`);
    const project = String(input).includes("/p1/") ? "p1" : "p2";
    return Response.json({
      items: [{ id: `m-${project}`, project_id: project, status: "active" }],
    });
  };
  try {
    const items = await loadEngineMaterialLibrary(["p1", "p2"]);
    assert.deepEqual(
      items.map((m) => m.id),
      ["m-p1", "m-p2"],
    );
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.startsWith("GET ") && call.endsWith("/materials")));
    assert.deepEqual(await loadEngineMaterialLibrary([]), []);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("library read rejects revoked project access instead of reporting an empty success", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ error: { code: "permission_denied", message: "revoked" } }, { status: 403 });
  try {
    await assert.rejects(loadEngineMaterialLibrary(["p1"]), { code: "permission_denied" });
  } finally {
    globalThis.fetch = original;
  }
});

test("upload persists files with folder paths, retains partial failures and notifies tool pickers", async () => {
  const original = globalThis.fetch;
  const changes: string[] = [];
  const stop = subscribeMaterialChanges((id) => changes.push(id));
  const file = new File(["content"], "note.txt");
  Object.defineProperty(file, "webkitRelativePath", { value: "folder/note.txt" });
  const bad = new File(["bad"], "bad.txt");
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/projects\/p1\/materials\/ingest$/);
    assert.equal(init?.method, "POST");
    const form = init?.body as FormData;
    if ((form.get("file") as File).name === "bad.txt")
      return Response.json({ error: { code: "permission_denied" } }, { status: 403 });
    assert.equal(form.get("relative_path"), "folder/note.txt");
    return Response.json({ material_id: "material-real", created: true, version: 1 });
  };
  try {
    const outcome = await uploadEngineMaterialFiles("p1", [file, bad]);
    assert.deepEqual(outcome.addedIds, ["material-real"]);
    assert.equal(outcome.failed, 1);
    assert.equal(outcome.failures[0]?.fileName, "bad.txt");
    assert.deepEqual(changes, ["p1"]);
  } finally {
    stop();
    globalThis.fetch = original;
  }
});

test("archive uses the material revision and only notifies after persistence succeeds", async () => {
  const original = globalThis.fetch;
  const changes: string[] = [];
  const stop = subscribeMaterialChanges((id) => changes.push(id));
  let rejected = false;
  globalThis.fetch = async (_input, init) => {
    const command = JSON.parse(String(init?.body));
    assert.equal(command.type, "material.archive");
    assert.equal(command.payload.material_id, "m1");
    assert.equal(command.payload.expected_version, 7);
    return rejected
      ? Response.json({ error: { code: "version_conflict" } }, { status: 409 })
      : Response.json({ result: {} });
  };
  try {
    await archiveLibraryMaterial({ id: "m1", project_id: "p1", version: 7 });
    assert.deepEqual(changes, ["p1"]);
    rejected = true;
    await assert.rejects(archiveLibraryMaterial({ id: "m1", project_id: "p1", version: 7 }));
    assert.deepEqual(changes, ["p1"]);
  } finally {
    stop();
    globalThis.fetch = original;
  }
});
