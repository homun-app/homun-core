import { test } from "node:test";
import assert from "node:assert/strict";
import { threeStepWindow } from "./islandPlan.mjs";

const step = (title, status) => ({ title, status });

test("<=6 steps: window shows all, no collapse groups", () => {
  const steps = [step("a", "done"), step("b", "doing"), step("c", "todo")];
  const w = threeStepWindow(steps);
  assert.equal(w.before.length, 0);
  assert.equal(w.after.length, 0);
  assert.deepEqual(w.window.map((s) => s.title), ["a", "b", "c"]);
});

test(">6 steps: centers a 3-step window on the in_progress step", () => {
  const steps = [
    step("1", "done"), step("2", "done"), step("3", "done"),
    step("4", "doing"), step("5", "todo"), step("6", "todo"), step("7", "todo"),
  ];
  const w = threeStepWindow(steps);
  assert.deepEqual(w.window.map((s) => s.title), ["3", "4", "5"]);
  assert.equal(w.before.length, 2);
  assert.equal(w.after.length, 2);
});

test(">6 steps with no in_progress: centers on first non-completed", () => {
  const steps = [
    step("1", "done"), step("2", "done"), step("3", "done"),
    step("4", "done"), step("5", "todo"), step("6", "todo"), step("7", "todo"),
  ];
  const w = threeStepWindow(steps);
  assert.equal(w.window[0].title, "4");
  assert.ok(w.window.some((s) => s.title === "5"));
});
