import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { greetingPeriod, selectGreetingKey } from "./chatGreeting.mjs";

const here = dirname(fileURLToPath(import.meta.url));

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

test("every locale exposes separate greeting headline and prompt text", () => {
  for (const locale of ["en", "it", "es", "fr", "de"]) {
    const catalog = JSON.parse(readFileSync(join(here, `../i18n/locales/${locale}.json`), "utf8"));
    for (const context of ["named", "anonymous", "project", "returning"]) {
      for (const index of ["0", "1", "2", "3"]) {
        const entry = catalog.chat.greetings[context][index];
        assert.equal(typeof entry.headline, "string", `${locale}.${context}.${index}.headline`);
        assert.equal(typeof entry.prompt, "string", `${locale}.${context}.${index}.prompt`);
        assert.ok(entry.headline.trim().length > 0);
        assert.ok(entry.prompt.trim().length > 0);
      }
    }
  }
});
