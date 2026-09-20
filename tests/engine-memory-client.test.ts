import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  addEngineMemory,
  fetchEngineMemoryStatus,
  listEngineMemories,
  recallEngineMemories,
} from "../apps/web/src/lib/engine-memory-client.ts";

describe("engine-memory-client", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("lists memories", async () => {
    mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({
          memories: [
            {
              id: "mem_1",
              workspace_id: "ws_local",
              text: "Cliente Acme",
              work_id: null,
              project_id: "proj_a",
              status: "approved",
              created_at: "2026-09-18T10:00:00Z",
              updated_at: "2026-09-18T10:00:00Z",
              created_by: "person_fabio",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const notes = await listEngineMemories({ projectId: "proj_a" });
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.text, "Cliente Acme");
  });

  it("adds an approved memory", async () => {
    mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({
          id: "mem_1",
          workspace_id: "ws_local",
          text: "Cliente Acme",
          work_id: null,
          project_id: "proj_a",
          status: "approved",
          created_at: "2026-09-18T10:00:00Z",
          updated_at: "2026-09-18T10:00:00Z",
          created_by: "person_fabio",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const note = await addEngineMemory({
      text: "Cliente Acme",
      actorId: "person_fabio",
      projectId: "proj_a",
    });
    assert.equal(note.id, "mem_1");
    assert.equal(note.status, "approved");
  });

  it("fetches memory status", async () => {
    mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({
          backend: "sqlite",
          ok: true,
          detail: "Ledger-only",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const status = await fetchEngineMemoryStatus();
    assert.equal(status.backend, "sqlite");
    assert.equal(status.ok, true);
  });

  it("recalls memories", async () => {
    mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({
          memories: [
            {
              id: "mem_1",
              workspace_id: "ws_local",
              text: "Cliente Acme",
              work_id: null,
              project_id: "proj_a",
              status: "approved",
              created_at: "2026-09-18T10:00:00Z",
              updated_at: "2026-09-18T10:00:00Z",
              created_by: "person_fabio",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const hits = await recallEngineMemories({ query: "Acme", projectId: "proj_a" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.text, "Cliente Acme");
  });
});
