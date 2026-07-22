import test from "node:test";
import assert from "node:assert/strict";

import {
  canContinueFromComputer,
  computerProgressRows,
} from "./onboardingComputer.mjs";

test("preparing image completes only the Docker row", () => {
  assert.deepEqual(
    computerProgressRows("preparing_image").map((row) => row.state),
    ["done", "active", "pending", "pending"],
  );
});

test("only observed ready status unlocks model selection", () => {
  assert.equal(
    canContinueFromComputer({ phase: "ready", ready: true, error: null }),
    true,
  );
  assert.equal(
    canContinueFromComputer({
      phase: "starting_container",
      ready: false,
      error: null,
    }),
    false,
  );
  assert.equal(
    canContinueFromComputer({ phase: "ready", ready: false, error: null }),
    false,
  );
});

test("failed state exposes retry without completing progress", () => {
  assert.equal(
    computerProgressRows("failed").some((row) => row.state === "error"),
    true,
  );
});
