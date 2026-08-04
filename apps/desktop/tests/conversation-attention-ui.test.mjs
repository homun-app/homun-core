import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const chat = await readFile(new URL("../src/components/ChatView.tsx", import.meta.url), "utf8");
const nav = await readFile(new URL("../src/data/mockData.ts", import.meta.url), "utf8");
const sidebar = await readFile(new URL("../src/components/SidebarFilters.tsx", import.meta.url), "utf8");

test("Tasks is not a top-level route or navigation destination", () => {
  assert.doesNotMatch(nav, /id:\s*["']tasks["'],\s*label:\s*["']nav\.tasks["']/);
  assert.doesNotMatch(app, /<TasksView|setActiveView\(["']tasks["']\)/);
});

test("pending effect resolution lives in the owning conversation", () => {
  assert.match(chat, /function InlineUncertainEffectPanel/);
  assert.match(app, /uncertainEffects={activeUncertainEffects}/);
});

test("the sidebar exposes a durable requires-attention filter", () => {
  assert.doesNotMatch(sidebar, /attentionOnly/);
  assert.match(sidebar, /toggleAttentionFilterStates/);
  assert.match(sidebar, /filter\.states\.includes\("waiting_user"\)/);
  assert.match(sidebar, /filter\.states\.includes\("failed"\)/);
  assert.match(sidebar, /filters\.requiresAttention/);
});
