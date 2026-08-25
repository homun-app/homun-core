import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

async function readOptionalText(url) {
  try {
    return await readFile(url, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const effectPanel = await readFile(new URL("../src/components/InlineUncertainEffectPanel.tsx", import.meta.url), "utf8");
const mockDataUrl = new URL("../src/data/mockData.ts", import.meta.url);
const mockData = await readOptionalText(mockDataUrl);
const navigationConfig = await readOptionalText(new URL("../src/data/navigationConfig.ts", import.meta.url));
const demoWorkspaceData = await readOptionalText(new URL("../src/data/demoWorkspaceData.ts", import.meta.url));
const sidebar = await readFile(new URL("../src/components/SidebarFilters.tsx", import.meta.url), "utf8");
const chatThreadCreation = await readFile(new URL("../src/lib/useChatThreadCreation.ts", import.meta.url), "utf8");

test("Tasks is not a top-level route or navigation destination", () => {
  assert.doesNotMatch(navigationConfig, /id:\s*["']tasks["'],\s*label:\s*["']nav\.tasks["']/);
  assert.doesNotMatch(app, /<TasksView|setActiveView\(["']tasks["']\)/);
});

test("mockData has been split into static config and demo data owners", async () => {
  await assert.rejects(access(mockDataUrl, constants.F_OK), { code: "ENOENT" });
  assert.match(navigationConfig, /export const navItems/);
  assert.match(navigationConfig, /export const settingsSections/);
  assert.match(navigationConfig, /export const settingsGroupLabels/);
  assert.match(demoWorkspaceData, /export const brainRun/);
  assert.match(demoWorkspaceData, /export const learningInsights/);
  assert.match(demoWorkspaceData, /export const automationProposals/);
});

test("mock data does not seed the canonical chat transcript", () => {
  assert.doesNotMatch(mockData + navigationConfig + demoWorkspaceData, /export const chatMessages/);
  assert.doesNotMatch(mockData + navigationConfig + demoWorkspaceData, /I'm ready\. Write to me\./);
});

test("mock data does not seed canonical capability connections", () => {
  assert.doesNotMatch(mockData + navigationConfig + demoWorkspaceData, /export const connections/);
});

test("mock data does not retain retired runtime read-model seeds", () => {
  assert.doesNotMatch(mockData + navigationConfig + demoWorkspaceData, /export const computerSession/);
  assert.doesNotMatch(mockData + navigationConfig + demoWorkspaceData, /export const tasks/);
  assert.doesNotMatch(mockData + navigationConfig + demoWorkspaceData, /export const approvals/);
  assert.doesNotMatch(mockData + navigationConfig + demoWorkspaceData, /export const runtimeHealth/);
  assert.doesNotMatch(mockData + navigationConfig + demoWorkspaceData, /export const memorySummary/);
  assert.doesNotMatch(mockData + navigationConfig + demoWorkspaceData, /export const drawerTasks/);
  assert.doesNotMatch(mockData + navigationConfig + demoWorkspaceData, /export const drawerProjects/);
});

test("navigation config does not retain demo or runtime seeds", () => {
  assert.doesNotMatch(navigationConfig, /learningInsights|automationProposals|brainRun/);
  assert.doesNotMatch(
    navigationConfig,
    /export const (chatMessages|connections|computerSession|tasks|approvals|runtimeHealth|memorySummary|drawerTasks|drawerProjects)/,
  );
});

test("demo workspace data does not own static shell navigation or settings", () => {
  assert.doesNotMatch(demoWorkspaceData, /export const navItems/);
  assert.doesNotMatch(demoWorkspaceData, /export const settingsSections/);
  assert.doesNotMatch(demoWorkspaceData, /export const settingsGroupLabels/);
});

test("chat thread creation hook does not own preview thread fallback state", () => {
  assert.doesNotMatch(chatThreadCreation, /starterMessages/);
  assert.doesNotMatch(chatThreadCreation, /thread_preview_/);
  assert.doesNotMatch(chatThreadCreation, /messageCount:\s*1/);
});

test("pending effect resolution lives in the owning conversation", () => {
  assert.match(effectPanel, /function InlineUncertainEffectPanel/);
  assert.match(app, /uncertainEffects={activeUncertainEffects}/);
});

test("the sidebar exposes a durable requires-attention filter", () => {
  assert.doesNotMatch(sidebar, /attentionOnly/);
  assert.match(sidebar, /toggleAttentionFilterStates/);
  assert.match(sidebar, /filter\.states\.includes\("waiting_user"\)/);
  assert.match(sidebar, /filter\.states\.includes\("failed"\)/);
  assert.match(sidebar, /filters\.requiresAttention/);
});
