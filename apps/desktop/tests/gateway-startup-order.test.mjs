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
  const startupStart = gatewayMain.indexOf(
    'eprintln!("turn broker: the only chat path; running lease-aware boot recovery")',
  );
  const startupEnd = gatewayMain.indexOf(
    "start_task_executor_worker(state.clone())",
    startupStart,
  );

  assert.notEqual(startupStart, -1, "boot startup block is missing");
  assert.notEqual(startupEnd, -1, "boot startup block boundary is missing");

  const startup = gatewayMain.slice(startupStart, startupEnd);
  const recovery = startup.search(/store\s*\.bump_process_generation\(\)/);
  const projectionReplay = startup.indexOf("projection_worker::drain_at_startup");
  const abortOrphans = startup.indexOf(
    "store.abort_orphaned_running_agent_runs",
  );
  const graph = startup.indexOf(
    "spawn_blocking(move || sweep_graph_on_startup(&st))",
  );

  assert.notEqual(recovery, -1, "boot recovery marker is missing");
  assert.notEqual(projectionReplay, -1, "projection replay marker is missing");
  assert.notEqual(abortOrphans, -1, "orphan run recovery marker is missing");
  assert.notEqual(graph, -1, "graph regeneration marker is missing");
  assert.ok(
    projectionReplay < abortOrphans,
    "committed outcomes must project before orphan runs are aborted",
  );
  assert.ok(
    recovery < graph,
    "graph regeneration must not race the critical boot recovery write",
  );
});
