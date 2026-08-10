import test from "node:test";
import assert from "node:assert/strict";
import { derivePlanStepDisplay, getDoneCriterionText } from "./planStepDisplay.mjs";

// ── derivePlanStepDisplay ──────────────────────────────────────────────────

test("doing step has doing class, bold title class, no icon, and animation enabled", () => {
  const display = derivePlanStepDisplay({ status: "doing", title: "Implement data models" });

  assert.equal(display.status, "doing");
  assert.equal(display.itemClassName, "status-doing");
  assert.ok(display.titleClassName.includes("plan-step-title--doing"));
  assert.equal(display.icon, "");
  assert.equal(display.animate, true);
  assert.equal(display.iconLabel, "In progress");
  assert.equal(display.showDoneCriterion, true);
});

test("done step has done class, checkmark icon, and strikethrough title class", () => {
  const display = derivePlanStepDisplay({ status: "done", title: "Set up project" });

  assert.equal(display.status, "done");
  assert.equal(display.itemClassName, "status-done");
  assert.ok(display.titleClassName.includes("plan-step-title--done"));
  assert.equal(display.icon, "\u2713"); // ✓
  assert.equal(display.animate, false);
  assert.equal(display.iconLabel, "Completed");
});

test("blocked step has blocked class, exclamation icon, and blocked title class", () => {
  const display = derivePlanStepDisplay({ status: "blocked", title: "Deploy" });

  assert.equal(display.status, "blocked");
  assert.equal(display.itemClassName, "status-blocked");
  assert.ok(display.titleClassName.includes("plan-step-title--blocked"));
  assert.equal(display.icon, "!");
  assert.equal(display.animate, false);
  assert.equal(display.iconLabel, "Blocked");
});

test("todo step falls back to default class with no icon or animation", () => {
  const display = derivePlanStepDisplay({ status: "todo", title: "Create API endpoints" });

  assert.equal(display.status, "todo");
  assert.equal(display.itemClassName, "status-todo");
  assert.equal(display.titleClassName, "plan-step-title");
  assert.equal(display.icon, "");
  assert.equal(display.animate, false);
  assert.equal(display.iconLabel, "Pending");
});

test("unknown status is normalised to todo", () => {
  const display = derivePlanStepDisplay({ status: "frobble", title: "???" });

  assert.equal(display.status, "todo");
  assert.equal(display.itemClassName, "status-todo");
  assert.equal(display.icon, "");
});

test("missing status defaults to todo", () => {
  const display = derivePlanStepDisplay({ title: "No status field" });

  assert.equal(display.status, "todo");
  assert.equal(display.itemClassName, "status-todo");
});

test("nullish step is treated as todo without throwing", () => {
  const display = derivePlanStepDisplay(undefined);

  assert.equal(display.status, "todo");
  assert.equal(display.itemClassName, "status-todo");
});

// ── getDoneCriterionText ───────────────────────────────────────────────────

test("getDoneCriterionText prefers done_criterion over detail", () => {
  const text = getDoneCriterionText({
    done_criterion: "Schema validates against contract",
    detail: "some detail",
  });

  assert.equal(text, "Schema validates against contract");
});

test("getDoneCriterionText falls back to detail when done_criterion is absent", () => {
  const text = getDoneCriterionText({ detail: "Files created and project compiles" });

  assert.equal(text, "Files created and project compiles");
});

test("getDoneCriterionText returns null for placeholder em-dash detail", () => {
  assert.equal(getDoneCriterionText({ detail: "\u2014" }), null); // —
  assert.equal(getDoneCriterionText({ detail: "  \u2014  " }), null);
});

test("getDoneCriterionText returns null for double-dash placeholder", () => {
  assert.equal(getDoneCriterionText({ detail: "--" }), null);
});

test("getDoneCriterionText returns null when no text is available", () => {
  assert.equal(getDoneCriterionText({}), null);
  assert.equal(getDoneCriterionText({ detail: "" }), null);
  assert.equal(getDoneCriterionText({ detail: "   " }), null);
  assert.equal(getDoneCriterionText({ done_criterion: null, detail: "" }), null);
});

test("getDoneCriterionText trims surrounding whitespace", () => {
  const text = getDoneCriterionText({ done_criterion: "  Endpoints respond correctly  " });

  assert.equal(text, "Endpoints respond correctly");
});

test("getDoneCriterionText treats null done_criterion as absent (falls back to detail)", () => {
  const text = getDoneCriterionText({
    done_criterion: null,
    detail: "deck rendered to PDF",
  });

  assert.equal(text, "deck rendered to PDF");
});
