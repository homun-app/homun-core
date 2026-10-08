import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  engineWorkToUiWork,
  isEngineBackedWork,
  mapEngineStatusToPhase,
  parseEngineWorkRecord,
} from "../apps/web/src/lib/conversation-engine-bridge.ts";

describe("mapEngineStatusToPhase", () => {
  it("maps engine statuses to simulation phases", () => {
    assert.equal(mapEngineStatusToPhase("draft"), "proposal");
    assert.equal(mapEngineStatusToPhase("waiting_input"), "waiting");
    assert.equal(mapEngineStatusToPhase("review"), "review");
    assert.equal(mapEngineStatusToPhase("completed"), "approved");
  });
});

describe("engineWorkToUiWork", () => {
  it("tags works as engine-backed and never as simulation", () => {
    const record = parseEngineWorkRecord({
      id: "work_1",
      title: "Catalogo",
      objective: "Prezzi aggiornati",
      status: "draft",
      version: 2,
      primary_conversation_id: "conv_1",
    });
    const work = engineWorkToUiWork(record);
    assert.equal(work.source, "engine");
    assert.equal(work.engineConversationId, "conv_1");
    assert.equal(work.phase, "proposal");
    assert.equal(isEngineBackedWork(work), true);
    assert.equal(isEngineBackedWork({ ...work, source: "simulation" }), false);
  });

  it("exposes plan and artifact revision counters for action gating", () => {
    const idle = parseEngineWorkRecord({
      id: "work_1",
      title: "Catalogo",
      status: "draft",
      version: 2,
      primary_conversation_id: "conv_1",
    });
    assert.equal(idle.current_plan_revision, 0);
    assert.equal(idle.current_artifact_version, 0);
    const started = parseEngineWorkRecord({
      id: "work_1",
      title: "Catalogo",
      status: "draft",
      version: 3,
      primary_conversation_id: "conv_1",
      current_plan_revision: 2,
      current_artifact_version: 1,
    });
    const work = engineWorkToUiWork(started);
    assert.equal(work.enginePlanRevision, 2);
    assert.equal(work.engineArtifactVersion, 1);
  });
});

it('projects named portal recipients without exposing actor ids as names', () => {
  const work = engineWorkToUiWork(parseEngineWorkRecord({
    id:'work_1', status:'waiting_input',
    pending_contribution:{id:'question', to_actor_id:'person_generated', recipient_name:'Marta',
      need:'Confermi la scadenza?', status:'pending', step_id:'question'},
  }));
  assert.equal(work.request?.to, 'Marta');
  assert.equal(work.request?.viaInvitation, true);
});
