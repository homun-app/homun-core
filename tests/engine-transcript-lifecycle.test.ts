import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canDropOverlay,
  planTranscriptLoad,
  type TranscriptView,
} from "../apps/web/src/lib/engine-transcript-lifecycle.ts";
import type { ConversationMessage } from "../apps/web/src/components/builder/conversation-types.ts";

const view = (over: Partial<TranscriptView>): TranscriptView => ({
  activeId: "work_1",
  conversationId: "conv_1",
  reloadSeq: 0,
  ...over,
});

test("an inventory refresh alone never triggers a transcript load", () => {
  const plan = planTranscriptLoad(view({}), view({}));
  assert.deepEqual(plan, { load: false, clearFirst: false, keepDuringLoad: false });
});

test("an explicit reload of the same work keeps the reader's content visible", () => {
  const plan = planTranscriptLoad(view({ reloadSeq: 3 }), view({ reloadSeq: 4 }));
  assert.deepEqual(plan, { load: true, clearFirst: false, keepDuringLoad: true });
});

test("switching work clears cached content before loading", () => {
  const plan = planTranscriptLoad(view({}), view({ activeId: "work_2", conversationId: "conv_2" }));
  assert.deepEqual(plan, { load: true, clearFirst: true, keepDuringLoad: false });
});

test("a new conversation id for the same work is treated as a switch", () => {
  const plan = planTranscriptLoad(view({}), view({ conversationId: "conv_other" }));
  assert.deepEqual(plan, { load: true, clearFirst: true, keepDuringLoad: false });
});

test("no active work or unresolved conversation stays idle", () => {
  assert.deepEqual(planTranscriptLoad(view({}), view({ activeId: null })), {
    load: false,
    clearFirst: false,
    keepDuringLoad: false,
  });
  assert.deepEqual(planTranscriptLoad(view({}), view({ conversationId: undefined })), {
    load: false,
    clearFirst: false,
    keepDuringLoad: false,
  });
});

test("duplicate reload sequences do not loop", () => {
  const first = planTranscriptLoad(view({ reloadSeq: 0 }), view({ reloadSeq: 1 }));
  assert.equal(first.load, true);
  const again = planTranscriptLoad(view({ reloadSeq: 1 }), view({ reloadSeq: 1 }));
  assert.equal(again.load, false);
});

function message(over: Partial<ConversationMessage>): ConversationMessage {
  return { who: "agent", text: "ciao", ...over };
}

test("the overlay is dropped only when no streamed turn is in flight", () => {
  assert.equal(canDropOverlay(undefined), true);
  assert.equal(canDropOverlay([message({ who: "you", text: "richiesta" })]), true);
  assert.equal(
    canDropOverlay([message({ partial: true, text: "", wait: { phase: "reading", startedAt: 0 } })]),
    false,
  );
  assert.equal(
    canDropOverlay([message({ who: "you" }), message({ partial: true }), message({ who: "you" })]),
    false,
  );
});
