import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareDelegation } from "../apps/web/src/lib/studio-delegation.ts";
const base = { id: "t", title: "Analisi", person: "elio", project: "", status: "todo" as const };
test("all new agent work defaults to stage and the configured reviewer", () => {
  const task = prepareDelegation({ ...base, assisted: true }, "user:giulia");
  assert.equal(task.training?.mode, "stage");
  assert.equal(task.approver, "user:giulia");
  assert.equal(task.assisted, false);
});
test("explicit context and supervision survive without modifying input", () => {
  const file = new File(["error"], "server.log");
  const original = {
    ...base,
    files: [file],
    materialLinks: [{ id: "doc", title: "Wiki", version: 2 }],
    costLimit: 0.5,
    training: { activity: "Logs", scope: "Read", mode: "review" as const },
    approver: "user:fabio",
  };
  const task = prepareDelegation(original, "user:giulia");
  assert.equal(task.files?.[0], file);
  assert.deepEqual(task.materialLinks, original.materialLinks);
  assert.equal(task.costLimit, 0.5);
  assert.equal(task.approver, "user:fabio");
  task.training!.mode = "stage";
  assert.equal(original.training.mode, "review");
});
test("human work does not acquire agent training", () =>
  assert.equal(prepareDelegation({ ...base, person: "user:giulia" }).training, undefined));
import { createProcedureRun, procedureIssue } from "../apps/web/src/lib/studio-pipelines.ts";
const procedure = {
  id: "p",
  name: "Analisi periodica",
  project: "",
  trigger: "interval" as const,
  time: "09:00",
  days: ["Lun"],
  interval: 60,
  from: "09:00",
  until: "18:00",
  event: "",
  active: false,
  steps: [],
};
test("repeated work keeps materials, budget, method and supervision", () => {
  const file = new File(["x"], "a.log");
  const run = createProcedureRun(
    {
      ...procedure,
      steps: [
        {
          id: "s",
          title: "Analisi",
          person: "elio",
          materials: "Wiki",
          files: [file],
          materialLinks: [{ id: "folder", version: 1, title: "Log" }],
          method: ["Raccogliere", "Verificare"],
          successCriteria: "Fonti citate",
          costLimit: 0.5,
          training: { activity: "Log", scope: "Cartella", mode: "review" },
          approval: true,
        },
      ],
    },
    "r",
  );
  assert.equal(run[0]!.files?.[0], file);
  assert.equal(run[0]!.materialLinks?.[0]?.id, "folder");
  assert.equal(run[0]!.costLimit, 0.5);
  assert.equal(run[0]!.training?.mode, "review");
  assert.equal(run[0]!.steps?.length, 2);
  assert.equal(run[0]!.successCriteria, "Fonti citate");
});
test("negative automation budget is refused", () =>
  assert.ok(
    procedureIssue({
      ...procedure,
      steps: [
        { id: "s", title: "A", person: "elio", materials: "", approval: true, costLimit: -1 },
      ],
    }),
  ));
import { delegationRequests } from "../apps/web/src/lib/studio-delegation.ts";
test("asking for a contribution creates one linked human task with the deadline", () => {
  const requests = delegationRequests({
    ...base,
    due: "2026-09-20T12:00",
    steps: [
      {
        id: "input",
        title: "Ricevere listino",
        reason: "Listino aggiornato",
        blocker: "user:giulia",
        done: false,
      },
    ],
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.requestFor, "t:input");
  assert.equal(requests[0]!.person, "user:giulia");
  assert.equal(requests[0]!.due, "2026-09-20T12:00");
  assert.equal(
    delegationRequests({
      ...base,
      steps: [{ id: "pipeline-gate", title: "Attesa", blocker: "bot:vera", done: false }],
    }).length,
    0,
  );
});
import { moveIssue } from "../apps/web/src/lib/studio-board.ts";
test("receiving material alone is not a method for an agent in training", () => {
  const task = prepareDelegation({
    ...base,
    steps: [{ id: "input", title: "Ricevere materiale", done: true }],
  });
  assert.match(moveIssue(task, "doing"), /metodo/);
});
