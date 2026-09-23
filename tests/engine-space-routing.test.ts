import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { loadComponent } = require("./helpers/load-component.cjs");
const path = "apps/web/src/components/builder/ConversationWorkspaceSpaceHost.tsx";
const { exports: component, components } = loadComponent(path, {
  scenarioForWork: () => ({ agent: "Agente" }),
});
const project = { id: "p1", name: "Progetto" };
const base = {
  engineMode: true,
  spaceData: { projects: [project] },
  visibleWorks: [],
  works: [],
  pending: [],
};

test("engine Materiali routes to the authoritative library, not the prototype callbacks", () => {
  const view = component.ConversationWorkspaceSpaceHost({ ...base, space: "Materiali" });
  assert.equal(view.type, components.get("EngineMaterials"));
  assert.equal(view.props.projects[0], project);
  assert.equal(view.props.onAdd, undefined);
});

test("engine Plugin exposes the same real capability and MCP panel as settings", () => {
  const view = component.ConversationWorkspaceSpaceHost({ ...base, space: "Plugin" });
  const children = [view, ...(Array.isArray(view.props.children) ? view.props.children : [])];
  assert.ok(
    children.some(
      (child) => child.type === components.get("ConversationCapabilitiesSettingsSection"),
    ),
  );
});

test("task deadline invokes the engine command with the current work and clears as null", async () => {
  const work = { id: "w1", revision: 7 };
  const calls: unknown[] = [];
  const view = component.ConversationWorkspaceSpaceHost({
    ...base,
    space: "Compiti",
    works: [work],
    onSetEngineDue: async (...args: unknown[]) => {
      calls.push(args);
    },
    setWorks: () => {
      assert.fail("must not mutate prototype state");
    },
  });
  await view.props.onDue("w1", "2026-09-30");
  await view.props.onDue("w1", "");
  assert.equal((calls[0] as unknown[])[0], work);
  assert.equal((calls[0] as unknown[])[1], "2026-09-30");
  assert.equal((calls[1] as unknown[])[1], null);
});

test("engine task deadline propagates a conflict for the UI to show; simulation keeps local behavior", async () => {
  const conflict = new Error("version_conflict");
  const view = component.ConversationWorkspaceSpaceHost({
    ...base,
    space: "Compiti",
    works: [{ id: "w1" }],
    onSetEngineDue: async () => {
      throw conflict;
    },
  });
  await assert.rejects(view.props.onDue("w1", "2026-09-30"), (error) => error === conflict);
  let works = [{ id: "w1", due: "" }];
  const simulated = component.ConversationWorkspaceSpaceHost({
    ...base,
    engineMode: false,
    space: "Compiti",
    setWorks: (update: (items: typeof works) => typeof works) => {
      works = update(works);
    },
  });
  await simulated.props.onDue("w1", "2026-09-30");
  assert.equal(works[0]?.due, "2026-09-30");
});
