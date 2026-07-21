import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const gatewayMain = readFileSync(
  join(here, "..", "..", "..", "crates", "desktop-gateway", "src", "main.rs"),
  "utf8",
);

test("lease recovery owns the unified database before graph regeneration starts", () => {
  const recovery = gatewayMain.indexOf("store.bump_process_generation()");
  const graph = gatewayMain.indexOf("spawn_blocking(move || sweep_graph_on_startup(&st))");

  assert.notEqual(recovery, -1, "boot recovery marker is missing");
  assert.notEqual(graph, -1, "graph regeneration marker is missing");
  assert.ok(
    recovery < graph,
    "graph regeneration must not race the critical boot recovery write",
  );
});
