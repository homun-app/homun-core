import test from "node:test";
import assert from "node:assert/strict";
import { greetingPeriod, selectGreetingKey } from "./chatGreeting.mjs";

test("the same seed stays stable", () => {
  assert.equal(
    selectGreetingKey({ hour: 9, hasName: true, seed: "thread-a" }),
    selectGreetingKey({ hour: 9, hasName: true, seed: "thread-a" }),
  );
});

test("different seeds rotate through the curated catalog", () => {
  const keys = new Set(
    ["a", "b", "c", "d", "e", "f"].map((seed) =>
      selectGreetingKey({ hour: 15, hasName: true, seed }),
    ),
  );
  assert.ok(keys.size > 1);
});

test("night and morning use different periods", () => {
  assert.notEqual(greetingPeriod(23), greetingPeriod(8));
});

test("named and unnamed greetings use separate translation keys", () => {
  const named = selectGreetingKey({ hour: 19, hasName: true, seed: "same" });
  const unnamed = selectGreetingKey({ hour: 19, hasName: false, seed: "same" });
  assert.match(named, /\.named\./);
  assert.match(unnamed, /\.anonymous\./);
});

test("project context selects a project-aware greeting", () => {
  const key = selectGreetingKey({ hour: 11, hasName: true, hasProject: true, seed: "project" });
  assert.match(key, /\.project\./);
});
