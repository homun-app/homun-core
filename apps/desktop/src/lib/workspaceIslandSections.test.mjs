import test from "node:test";
import assert from "node:assert/strict";
import {
  nextWorkspaceSection,
  projectWorkspaceSections,
  workspaceSectionSelection,
} from "./workspaceIslandSections.mjs";

test("empty unavailable capabilities produce no rail", () => {
  assert.deepEqual(projectWorkspaceSections({}), []);
});

test("activity exists only for durable or live work", () => {
  assert.deepEqual(
    projectWorkspaceSections({ planSteps: [], activity: [], streaming: false }),
    [],
  );
  assert.equal(
    projectWorkspaceSections({
      planSteps: [{ status: "doing" }],
      streaming: true,
    })[0].id,
    "activity",
  );
});

test("browser requires an active session or verified snapshot", () => {
  assert.equal(
    projectWorkspaceSections({
      browser: { active: false, snapshotVerified: false },
    }).some((section) => section.id === "browser"),
    false,
  );
  assert.equal(
    projectWorkspaceSections({
      browser: { active: false, snapshotVerified: true },
    }).some((section) => section.id === "browser"),
    true,
  );
});

test("artifacts and sources never appear as empty placeholders", () => {
  const sections = projectWorkspaceSections({
    artifacts: [{ id: "artifact-1" }],
    sources: [{ id: "source-1" }],
  });
  assert.deepEqual(
    sections.map((section) => section.id),
    ["artifacts", "sources"],
  );
});

test("terminal is never exposed as a workspace capability", () => {
  const sections = projectWorkspaceSections({
    terminal: { active: true },
    activity: ["durable event"],
  });
  assert.equal(sections.some((section) => section.id === "terminal"), false);
});

test("clicking the active section collapses and siblings swap directly", () => {
  assert.equal(nextWorkspaceSection(null, "activity"), "activity");
  assert.equal(nextWorkspaceSection("activity", "artifacts"), "artifacts");
  assert.equal(nextWorkspaceSection("artifacts", "artifacts"), null);
});

test("browser rail click keeps the side island closed so PiP stays visible", () => {
  assert.equal(nextWorkspaceSection(null, "browser"), null);
  assert.equal(nextWorkspaceSection("activity", "browser"), null);
  assert.deepEqual(workspaceSectionSelection("activity", "browser"), {
    activeSection: null,
    browserDockRequested: true,
  });
  assert.deepEqual(workspaceSectionSelection(null, "activity"), {
    activeSection: "activity",
    browserDockRequested: false,
  });
});
