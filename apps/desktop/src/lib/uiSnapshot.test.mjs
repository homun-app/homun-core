import test from "node:test";
import assert from "node:assert/strict";

import {
  reconcileChatMessages,
  reconcileMemoryArtifacts,
} from "./uiSnapshot.mjs";

function message(overrides = {}) {
  return {
    id: "message-1",
    role: "assistant",
    text: "stable",
    timestamp: "2026-07-20T12:00:00Z",
    attachments: [],
    eventParts: [],
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    reference: "artifact-1",
    name: "report.md",
    title: "Report",
    artifact_type: "markdown",
    source: "project",
    project_relative_path: "docs/report.md",
    project_path: "/project/docs/report.md",
    managed_path: null,
    size: 120,
    updated: false,
    thread: "thread-1",
    ...overrides,
  };
}

test("unchanged message polling reuses the current snapshot", () => {
  const current = [message()];
  const incoming = [message()];
  assert.equal(reconcileChatMessages(current, incoming), current);
});

test("a real message change accepts the incoming snapshot", () => {
  const current = [message({ text: "before" })];
  const incoming = [message({ text: "after" })];
  assert.equal(reconcileChatMessages(current, incoming), incoming);
});

test("structured event changes are not hidden by reconciliation", () => {
  const current = [message({ eventParts: [{ type: "activity", text: "one" }] })];
  const incoming = [message({ eventParts: [{ type: "activity", text: "two" }] })];
  assert.equal(reconcileChatMessages(current, incoming), incoming);
});

test("attachment and metric changes are not hidden by reconciliation", () => {
  const current = [message({ attachments: [{ artifactId: "a", sizeBytes: 1 }] })];
  const incoming = [message({ attachments: [{ artifactId: "a", sizeBytes: 2 }] })];
  assert.equal(reconcileChatMessages(current, incoming), incoming);

  const currentMetrics = [message({ metrics: { generationTokens: 1 } })];
  const incomingMetrics = [message({ metrics: { generationTokens: 2 } })];
  assert.equal(reconcileChatMessages(currentMetrics, incomingMetrics), incomingMetrics);
});

test("message insertion and removal accept the incoming snapshot", () => {
  const one = [message({ id: "one" })];
  const two = [message({ id: "one" }), message({ id: "two" })];
  assert.equal(reconcileChatMessages(one, two), two);
  assert.equal(reconcileChatMessages(two, one), one);
});

test("unchanged artifact catalogs retain object identity", () => {
  const current = [artifact()];
  const incoming = [artifact()];
  assert.equal(reconcileMemoryArtifacts(current, incoming), current);
});

test("changed artifact metadata accepts the incoming catalog", () => {
  const current = [artifact()];
  const incoming = [artifact({ updated: true })];
  assert.equal(reconcileMemoryArtifacts(current, incoming), incoming);
});

test("changed artifact authorization paths accept the incoming catalog", () => {
  const current = [artifact()];
  const incoming = [artifact({ project_path: "/other/report.md" })];
  assert.equal(reconcileMemoryArtifacts(current, incoming), incoming);
});
