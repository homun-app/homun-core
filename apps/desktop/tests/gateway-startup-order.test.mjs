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
const gatewayTurnRecovery = readFileSync(
  join(
    here,
    "..",
    "..",
    "..",
    "crates",
    "desktop-gateway",
    "src",
    "gateway_turn_recovery.rs",
  ),
  "utf8",
);
const gatewayBackgroundStartup = readFileSync(
  join(
    here,
    "..",
    "..",
    "..",
    "crates",
    "desktop-gateway",
    "src",
    "gateway_background_startup.rs",
  ),
  "utf8",
);

test("lease recovery owns the unified database before graph regeneration starts", () => {
  const startupRecovery = gatewayMain.indexOf(
    "gateway_turn_recovery::recover_gateway_chat_turns_at_startup(&state).await",
  );
  const startupBackground = gatewayMain.indexOf(
    "gateway_background_startup::start_gateway_background_services(state.clone())",
    startupRecovery,
  );

  assert.notEqual(startupRecovery, -1, "turn recovery delegation is missing");
  assert.notEqual(startupBackground, -1, "background startup delegation is missing");
  assert.ok(
    startupRecovery < startupBackground,
    "background startup must wait until lease recovery has been delegated",
  );

  const recoveryOrder = gatewayTurnRecovery.indexOf("GATEWAY_TURN_RECOVERY_STEPS");
  const bumpStep = gatewayTurnRecovery.indexOf(
    "GatewayTurnRecoveryStep::BumpProcessGenerationAndPurgeJournal",
    recoveryOrder,
  );
  const projectionStep = gatewayTurnRecovery.indexOf(
    "GatewayTurnRecoveryStep::DrainProjectionOutbox",
    bumpStep,
  );
  const brokerRecoveryStep = gatewayTurnRecovery.indexOf(
    "GatewayTurnRecoveryStep::RecoverChatTurnsFromBroker",
    projectionStep,
  );
  const recovery = gatewayTurnRecovery.search(/store\s*\.bump_process_generation\(\)/);
  const projectionReplay = gatewayTurnRecovery.indexOf(
    "projection_worker::drain_at_startup",
  );
  const abortOrphans = gatewayTurnRecovery.indexOf(
    "store.abort_orphaned_running_agent_runs",
  );
  const graph = gatewayBackgroundStartup.indexOf(
    "tokio::task::spawn_blocking(move || crate::sweep_graph_on_startup(&st))",
  );

  assert.notEqual(recoveryOrder, -1, "turn recovery step list is missing");
  assert.notEqual(bumpStep, -1, "process generation recovery step is missing");
  assert.notEqual(projectionStep, -1, "projection replay step is missing");
  assert.notEqual(brokerRecoveryStep, -1, "broker recovery step is missing");
  assert.notEqual(recovery, -1, "boot recovery marker is missing");
  assert.notEqual(projectionReplay, -1, "projection replay marker is missing");
  assert.notEqual(abortOrphans, -1, "orphan run recovery marker is missing");
  assert.notEqual(graph, -1, "graph regeneration marker is missing");
  assert.ok(
    bumpStep < projectionStep && projectionStep < brokerRecoveryStep,
    "turn recovery steps must fence the process and replay projections before broker recovery",
  );
  assert.ok(
    recovery < projectionReplay && projectionReplay < abortOrphans,
    "committed outcomes must project before orphan runs are aborted",
  );
});
