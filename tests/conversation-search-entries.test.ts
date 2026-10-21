import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { loadComponent } = require("./helpers/load-component.cjs");
const { describeCron } = await import("../apps/web/src/lib/cadence-language.ts");

const path = "apps/web/src/components/builder/conversation-search-entries.ts";
const demoPeople = ["Marta", "Vera", "Elio", "Giulia", "Fabio"];
const { exports: searchModule } = loadComponent(path, {
  spacePeople: demoPeople,
  scenarioForWork: (w: { source?: string }) =>
    w && w.source === "engine"
      ? { agent: "Homun", result: "", body: "" }
      : { agent: "Vera", result: "Relazione demo", body: "Corpo della relazione demo" },
  describeCron: (cron: string) => describeCron(cron),
  memberProfile: (name: string, profiles: Record<string, unknown>) =>
    (profiles && profiles[name]) || {
      role: "Collaboratore demo",
      bio: "",
      skills: [],
      tone: "",
      plugins: [],
    },
  isHumanMember: () => false,
});

const simulatedRoutine = {
  id: "routine_sim",
  name: "Controllo demo",
  workId: "work_sim",
  schedule: "Ogni lunedì alle 09:00 · Europe/Rome",
  active: true,
};
const engineRoutine = {
  id: "routine_engine_1",
  name: "Verifica listini settimanale",
  cron: "0 9 * * 1",
  cron_timezone: "Europe/Rome",
  conversation_id: "conv_1",
  template: { title: "Verifica listini", objective: "Confronta i listini", plan_steps: [] },
  status: "active",
  last_run_work_id: null,
  last_scheduled_for: null,
  skip_until: null,
  next_run_at: "2026-10-26T08:00:00+00:00",
  revision: 1,
};
const simulatedMaterial = {
  id: "mat_sim",
  name: "Relazione demo",
  body: "Testo del materiale demo",
  path: "Demo/relazione.md",
  addedAt: "2026-10-01",
};
const simulatedWork = {
  id: "work_sim",
  title: "Lavoro demo",
  scenario: 0,
  phase: "review",
  due: "",
  messages: [{ who: "you", text: "ciao dalla demo" }],
  files: [],
  contribution: "",
  revision: 1,
  feedback: "",
  humanResult: "Relazione consegnata demo",
};
const engineWork = {
  id: "work_engine_1",
  title: "Confronto listini",
  scenario: 0,
  phase: "review",
  due: "",
  messages: [{ who: "agent", sender: "Homun", text: "Piano pronto dal motore" }],
  files: [],
  contribution: "",
  revision: 3,
  feedback: "",
  source: "engine",
  engineStatus: "review",
  engineLatestArtifact: {
    id: "art_1",
    version: 2,
    title: "Report listini settembre",
    content: "Il confronto evidenzia differenze sui listini",
  },
};
const engineWorkWithoutArtifact = {
  ...engineWork,
  id: "work_engine_2",
  title: "Bozza in revisione",
  engineLatestArtifact: undefined,
};
const engineAgents = [
  { id: "agent_ada", name: "Ada", role: "Analista listini", responsibility: "Confronta i listini" },
  { id: "agent_bravo", name: "Bruno", role: "Redattore", responsibility: "Scrive le relazioni" },
];
const engineMaterials = [
  {
    id: "mat_engine_1",
    project_id: "project_real",
    title: "Listino settembre.csv",
    text: "prezzi a settembre",
  },
];
/** What projectWorkspaceData("engine", …) feeds the caller in engine mode — with
 * simulated residue in the fields the builder must never read in engine mode. */
const dirtyEngineProjection = {
  teams: [
    {
      id: "team_real",
      name: "Commerciale",
      members: ["agent_ada", "agent_bravo"],
      leader: "agent_ada",
      brief: "Offerte",
    },
  ],
  projects: [
    { id: "project_real", name: "Prezzi settembre", teamId: "team_real", brief: "Confronto" },
  ],
  routines: [simulatedRoutine],
  profiles: { Gianni: { role: "Collaboratore demo", bio: "", skills: [], tone: "", plugins: [] } },
  removedPeople: [],
};

function build(overrides: Record<string, unknown>) {
  const opened: unknown[][] = [];
  const openedWorks: string[] = [];
  const previews: string[] = [];
  const entries = searchModule.buildConversationSearchEntries({
    backend: "simulation",
    library: [],
    visibleWorks: [],
    scenarios: [],
    spaceData: { teams: [], projects: [], routines: [simulatedRoutine] },
    workStatus: () => "in bozza",
    openSpace: (...args: unknown[]) => opened.push(args),
    openWork: (id: string) => openedWorks.push(id),
    openResultPreview: (w: { id: string }) => previews.push(w.id),
    ...overrides,
  });
  return { entries, opened, openedWorks, previews };
}

test("engine mode: Automazioni entries come only from engine routines and open engine ids", () => {
  const { entries, opened } = build({
    backend: "engine",
    spaceData: dirtyEngineProjection,
    engineRoutines: [engineRoutine],
  });
  const automations = entries.filter((e: { kind: string }) => e.kind === "Automazioni");
  assert.equal(automations.length, 1);
  assert.equal(automations[0].id, "routine_engine_1");
  assert.ok(!entries.some((e: { id: string }) => e.id === "routine_sim"));
  assert.match(automations[0].context, /ogni lunedì alle 9:00/);
  automations[0].open();
  assert.deepEqual(opened, [["Automazioni", "", "routine_engine_1"]]);
});

test("simulation mode: simulated routines still produce their entries", () => {
  const { entries, opened } = build({});
  const automations = entries.filter((e: { kind: string }) => e.kind === "Automazioni");
  assert.equal(automations.length, 1);
  assert.equal(automations[0].id, "routine_sim");
  automations[0].open();
  assert.deepEqual(opened, [["Automazioni", "", "routine_sim"]]);
});

test("engine mode without routines: no Automazioni entries at all", () => {
  const { entries } = build({ backend: "engine", spaceData: dirtyEngineProjection });
  assert.equal(entries.filter((e: { kind: string }) => e.kind === "Automazioni").length, 0);
});

test("engine mode with a full simulation around: no entry carries demo people or simulated ids/titles", () => {
  const { entries } = build({
    backend: "engine",
    library: [simulatedMaterial],
    visibleWorks: [simulatedWork, engineWork, engineWorkWithoutArtifact],
    scenarios: [],
    spaceData: dirtyEngineProjection,
    engineRoutines: [engineRoutine],
    engineAgents,
    engineMaterials,
  });
  const flat = JSON.stringify(entries);
  for (const leak of [
    "Marta",
    "Vera",
    "Elio",
    "Giulia",
    "Fabio",
    "Gianni",
    "routine_sim",
    "team_sim",
    "proj_sim",
    "work_sim",
    "mat_sim",
    "Lavoro demo",
    "Relazione demo",
    "Controllo demo",
    "ciao dalla demo",
  ]) {
    assert.ok(!flat.includes(leak), `engine search must not carry "${leak}"`);
  }
});

test("engine mode: Collaboratori entries mirror engine agents 1:1 and open them by engine id", () => {
  const { entries, opened } = build({
    backend: "engine",
    spaceData: dirtyEngineProjection,
    engineAgents,
  });
  const collaborators = entries.filter((e: { kind: string }) => e.kind === "Collaboratori");
  assert.deepEqual(Array.from(collaborators.map((c: { id: string }) => c.id)), [
    "agent_ada",
    "agent_bravo",
  ]);
  assert.deepEqual(Array.from(collaborators.map((c: { title: string }) => c.title)), [
    "Ada",
    "Bruno",
  ]);
  collaborators[0].open();
  collaborators[1].open();
  assert.deepEqual(opened, [
    ["Squadra", "agents", "agent_ada"],
    ["Squadra", "agents", "agent_bravo"],
  ]);
});

test("engine mode: Materiali entries come from engine materials, results from engine artifacts", () => {
  const { entries, openedWorks, previews } = build({
    backend: "engine",
    library: [simulatedMaterial],
    visibleWorks: [simulatedWork, engineWork, engineWorkWithoutArtifact],
    spaceData: dirtyEngineProjection,
    engineMaterials,
  });
  const materials = entries.filter(
    (e: { kind: string; id: string }) => e.kind === "Materiali" && !e.id.endsWith(":result"),
  );
  assert.deepEqual(Array.from(materials.map((m: { id: string }) => m.id)), ["mat_engine_1"]);
  assert.equal(materials[0].title, "Listino settembre.csv");
  const results = entries.filter((e: { id: string }) => e.id.endsWith(":result"));
  assert.deepEqual(Array.from(results.map((r: { id: string }) => r.id)), ["work_engine_1:result"]);
  assert.equal(results[0].title, "Report listini settembre");
  assert.equal(results[0].text, "Il confronto evidenzia differenze sui listini");
  results[0].open();
  assert.deepEqual(openedWorks, ["work_engine_1"]);
  assert.deepEqual(previews, []);
});

test("engine mode: works and messages come only from engine works, teams show agent names", () => {
  const { entries } = build({
    backend: "engine",
    visibleWorks: [simulatedWork, engineWork, engineWorkWithoutArtifact],
    spaceData: dirtyEngineProjection,
    engineAgents,
  });
  assert.deepEqual(
    Array.from(
      entries.filter((e: { kind: string }) => e.kind === "Lavori").map((e: { id: string }) => e.id),
    ),
    ["work_engine_1", "work_engine_2"],
  );
  assert.deepEqual(
    Array.from(
      entries
        .filter((e: { kind: string }) => e.kind === "Messaggi")
        .map((e: { id: string }) => e.id),
    ),
    ["work_engine_1:message:0", "work_engine_2:message:0"],
  );
  const team = entries.find((e: { kind: string }) => e.kind === "Team");
  assert.match(team.context, /Ada, Bruno/);
  assert.ok(!team.context.includes("agent_ada"));
});

test("simulation mode: the entry list stays exactly as today (regression lock)", () => {
  const { entries } = build({
    backend: "simulation",
    library: [simulatedMaterial],
    visibleWorks: [simulatedWork],
    scenarios: [],
    spaceData: dirtyEngineProjection,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(entries.map((e: { kind: string; id: string }) => [e.kind, e.id]))),
    [
      ["Materiali", "mat_sim"],
      ["Lavori", "work_sim"],
      ["Messaggi", "work_sim:message:0"],
      ["Materiali", "work_sim:result"],
      ["Team", "team_real"],
      ["Progetti", "project_real"],
      ["Automazioni", "routine_sim"],
      ["Collaboratori", "person:Marta"],
      ["Collaboratori", "person:Vera"],
      ["Collaboratori", "person:Elio"],
      ["Collaboratori", "person:Giulia"],
      ["Collaboratori", "person:Fabio"],
      ["Collaboratori", "person:Gianni"],
    ],
  );
});
