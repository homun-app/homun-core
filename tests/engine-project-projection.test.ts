import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectWorkspaceData,
  engineWorkPanelMessage,
} from "../apps/web/src/lib/engine-project-projection.ts";

test("engine project navigation uses only authoritative inventory, including after reload", () => {
  const simulated = {
    teams: [],
    routines: [],
    projects: [{ id: "fake", name: "Demo", teamId: "", brief: "" }],
  };
  const projects = [
    {
      id: "project_real",
      workspace_id: "ws_local",
      name: "Prezzi settembre",
      description: "Confronto",
      version: 2,
      team_ids: [],
      member_ids: [],
      conversation_ids: ["conv_real"],
      status: "active",
    },
  ];
  const engine = { projects, teams: [] };
  const actual = projectWorkspaceData("engine", simulated, engine);
  assert.deepEqual(actual.projects, [
    { id: "project_real", name: "Prezzi settembre", brief: "Confronto", teamId: "" },
  ]);
  assert.equal(projectWorkspaceData("engine", simulated, { projects: [], teams: [] }).projects.length, 0);
  assert.equal(projectWorkspaceData("simulation", simulated, engine), simulated);
  assert.deepEqual(
    projectWorkspaceData("engine", simulated, {
      projects: JSON.parse(JSON.stringify(projects)),
      teams: [],
    }),
    actual,
  );
});

test("engine projection carries no simulation field: routines, teams, people stay out", () => {
  const simulated = {
    detachedChats: [{ id: "chat_sim", title: "Chat demo", messages: [] }],
    installedPlugins: ["Trello"],
    removedPeople: ["Marta"],
    profiles: { Gianni: { role: "Collaboratore", bio: "", skills: [], tone: "", plugins: [] } },
    teams: [
      { id: "team_sim", name: "Team demo", members: ["Marta"], leader: "Marta", brief: "demo" },
    ],
    routines: [
      {
        id: "routine_sim",
        name: "Controllo demo",
        workId: "work_sim",
        schedule: "Ogni lunedì",
        active: true,
      },
    ],
    projects: [{ id: "fake", name: "Demo", teamId: "", brief: "" }],
  };
  const projects = [
    {
      id: "project_real",
      workspace_id: "ws_local",
      name: "Prezzi settembre",
      description: "Confronto",
      version: 2,
      team_ids: [],
      member_ids: [],
      conversation_ids: [],
      status: "active",
    },
  ];
  const teams = [
    {
      id: "team_real",
      workspace_id: "ws_local",
      name: "Commerciale",
      description: "Offerte",
      revision: 1,
      member_ids: ["agent_ada"],
      coordinator_id: "agent_ada",
      status: "active",
    },
  ];
  const actual = projectWorkspaceData("engine", simulated, { projects, teams });
  assert.deepEqual(actual.routines, []);
  assert.deepEqual(actual.profiles, {});
  assert.deepEqual(actual.removedPeople, []);
  assert.deepEqual(actual.detachedChats, []);
  assert.deepEqual(actual.installedPlugins, []);
  assert.deepEqual(actual.teams, [
    {
      id: "team_real",
      name: "Commerciale",
      members: ["agent_ada"],
      leader: "agent_ada",
      brief: "Offerte",
    },
  ]);
  const flat = JSON.stringify(actual);
  for (const leaked of ["routine_sim", "team_sim", "Gianni", "chat_sim", "Trello", "Marta", "Demo"])
    assert.ok(!flat.includes(leaked), `engine projection must not carry "${leaked}"`);
});

test("real work states never offer simulated delivery or approval", () => {
  assert.match(engineWorkPanelMessage("running"), /esecuzione/i);
  assert.match(engineWorkPanelMessage("review"), /risultato.*conversazione/i);
  assert.match(engineWorkPanelMessage("failed"), /non.*completata/);
  for (const state of ["draft", "ready", "running", "review", "completed", "failed", "paused"]) {
    assert.doesNotMatch(engineWorkPanelMessage(state), /simula|dimostrativa|Approva bozza/i);
    assert.doesNotMatch(
      engineWorkPanelMessage(state, { status: "pending_confirmation", capability: "compare_csv" }),
      /simula|dimostrativa|Approva bozza/i,
    );
  }
});

test("a pending brief tells the person to confirm; a confirmed brief names its material need", () => {
  assert.match(
    engineWorkPanelMessage("draft", { status: "pending_confirmation" }),
    /confermala per affidare/i,
  );
  assert.match(engineWorkPanelMessage("draft", { status: "failed" }), /non è stata completata/i);
  assert.match(
    engineWorkPanelMessage("draft", { status: "confirmed", capability: "compare_csv" }),
    /aggiungi i due listini/i,
  );
  assert.match(
    engineWorkPanelMessage("draft", { status: "confirmed", capability: "read_material" }),
    /carica il materiale/i,
  );
  assert.match(
    engineWorkPanelMessage("draft", { status: "confirmed", capability: "general" }),
    /prossimi passi si concordano in chat/i,
  );
});

test("project inventory read carries actor identity and surfaces denial without demo fallback", async () => {
  const { listEngineProjects } = await import("../apps/web/src/lib/engine-projects-client.ts");
  const previous = globalThis.fetch;
  let identity = "";
  globalThis.fetch = async (_url, init) => {
    identity = new Headers(init?.headers).get("X-Homun-Actor-Id") ?? "";
    return new Response(
      JSON.stringify({ detail: { code: "permission_denied", message: "Revoked" } }),
      { status: 403 },
    );
  };
  try {
    await assert.rejects(
      listEngineProjects("ws_local", "http://localhost", { id: "reader", displayName: "Reader" }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, "permission_denied");
        return true;
      },
    );
    assert.equal(identity, "reader");
  } finally {
    globalThis.fetch = previous;
  }
});
