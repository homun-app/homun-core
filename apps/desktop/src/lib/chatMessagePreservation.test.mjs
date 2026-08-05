import assert from "node:assert/strict";
import test from "node:test";

import {
  hasPendingLocalMessages,
  shouldPreserveLocalMessages,
} from "./chatMessagePreservation.mjs";

test("hasPendingLocalMessages detects optimistic local messages", () => {
  assert.equal(hasPendingLocalMessages([{ id: "server_1" }]), false);
  assert.equal(hasPendingLocalMessages([{ id: "local_1" }]), true);
});

test("shouldPreserveLocalMessages keeps protected local messages missing from backend", () => {
  assert.equal(
    shouldPreserveLocalMessages({
      currentMessages: [{ id: "server_1" }, { id: "local_pending" }],
      incomingMessages: [{ id: "server_1" }],
      isProtected: true,
    }),
    true,
  );
});

test("shouldPreserveLocalMessages allows refresh when thread is not protected", () => {
  assert.equal(
    shouldPreserveLocalMessages({
      currentMessages: [{ id: "local_pending" }],
      incomingMessages: [],
      isProtected: false,
    }),
    false,
  );
});

test("shouldPreserveLocalMessages allows refresh once backend includes the local id", () => {
  assert.equal(
    shouldPreserveLocalMessages({
      currentMessages: [{ id: "local_pending" }],
      incomingMessages: [{ id: "local_pending" }],
      isProtected: true,
    }),
    false,
  );
});
