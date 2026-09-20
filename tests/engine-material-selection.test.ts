import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eligibleForComparison,
  eligibleForRead,
  materialOptionLabel,
} from "../apps/web/src/lib/engine-material-selection.ts";
import type { EngineMaterial } from "../apps/web/src/lib/engine-projects-client.ts";

function material(over: Partial<EngineMaterial>): EngineMaterial {
  return {
    id: "mat_1",
    workspace_id: "ws_local",
    project_id: "proj_1",
    title: "Listino",
    kind: "file_ref",
    text: "",
    source_uri: null,
    content_hash: "abc",
    mime_type: "text/csv",
    version: 1,
    status: "active",
    created_by: "person_fabio",
    storage_relpath: "materials/x/original",
    byte_size: 10,
    extract_status: "extracted",
    origin_name: "listino.csv",
    ...over,
  } as EngineMaterial;
}

test("read eligibility follows format, size and extract status", () => {
  assert.equal(eligibleForRead(material({})), true);
  assert.equal(eligibleForRead(material({ origin_name: "archivio.zip" })), false);
  assert.equal(eligibleForRead(material({ byte_size: 3 * 1024 * 1024 })), false);
  assert.equal(eligibleForRead(material({ extract_status: "unsupported" })), false);
  assert.equal(eligibleForRead(material({ status: "archived" })), false);
  assert.equal(eligibleForRead(material({ content_hash: null, storage_relpath: null })), false);
  assert.equal(eligibleForRead(material({ origin_name: "nota.pdf", mime_type: "application/pdf" })), true);
});

test("comparison eligibility accepts only managed active CSV files", () => {
  assert.equal(eligibleForComparison(material({})), true);
  assert.equal(eligibleForComparison(material({ origin_name: "nota.txt" })), false);
  assert.equal(eligibleForComparison(material({ status: "archived" })), false);
  assert.equal(eligibleForComparison(material({ byte_size: 0 })), false);
});

test("option labels show name, version and size", () => {
  assert.equal(materialOptionLabel(material({ version: 3, byte_size: 42 })), "listino.csv · v3 · 42 B");
  assert.equal(
    materialOptionLabel(material({ origin_name: null, byte_size: null, title: "Nota" })),
    "Nota · v1 · dimensione n/d",
  );
});

test("prepare from existing materials never uploads", async () => {
  const { prepareComparisonFromMaterials } = await import(
    "../apps/web/src/lib/engine-price-comparison-client.ts"
  );
  const { prepareReadFromMaterial } = await import(
    "../apps/web/src/lib/engine-material-read-client.ts"
  );
  const old = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: String(init?.method ?? "GET"), body: init?.body });
    if (String(url).includes("/price-comparisons") && init?.method === "POST") {
      return Response.json({ id: "cmp" });
    }
    if (String(url).includes("/material-reads") && init?.method === "POST") {
      return Response.json({ id: "rd" });
    }
    if (String(url).endsWith("/works")) {
      return Response.json({ items: [{ id: "work_1", version: 3 }] });
    }
    return Response.json({ items: [] });
  };
  const work = {
    id: "work_1",
    engineConversationId: "conv_1",
    scenario: 0,
    title: "T",
    phase: "proposal",
    due: "",
    messages: [],
    files: [],
    contribution: "",
    revision: 3,
    feedback: "",
    source: "engine",
  } as never;
  try {
    await prepareComparisonFromMaterials(work, "mat_a", "mat_b", "cmp-op");
    await prepareReadFromMaterial(work, "mat_c", "read-op");
    const posts = calls.filter((call) => call.method === "POST");
    assert.equal(posts.length, 2);
    assert.deepEqual(JSON.parse(String(posts[0].body)), {
      command_id: "cmp-op",
      left_material_id: "mat_a",
      right_material_id: "mat_b",
      expected_version: 3,
      max_rows: 10000,
    });
    assert.deepEqual(JSON.parse(String(posts[1].body)), {
      command_id: "read-op",
      material_id: "mat_c",
      expected_version: 3,
    });
    // No multipart anywhere: existing sources are referenced, never re-uploaded.
    assert.ok(calls.every((call) => !String(call.body ?? "").includes("form-data")));
  } finally {
    globalThis.fetch = old;
  }
});
