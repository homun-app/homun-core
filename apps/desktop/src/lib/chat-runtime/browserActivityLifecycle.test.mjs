import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveBrowserStatus,
  deriveConversationPlan,
} from "./browserActivityLifecycle.mjs";

describe("deriveBrowserStatus", () => {
  it("returns active=true, snapshotVerified=true, failed=false when all green", () => {
    const result = deriveBrowserStatus(
      { active: true, activity: "browsing" },
      "data:image/png;base64,abc",
      null,
    );
    assert.deepStrictEqual(result, {
      active: true,
      snapshotVerified: true,
      failed: false,
    });
  });

  it("returns active=false when live status is inactive", () => {
    const result = deriveBrowserStatus(
      { active: false, activity: null },
      null,
      null,
    );
    assert.deepStrictEqual(result, {
      active: false,
      snapshotVerified: false,
      failed: false,
    });
  });

  it("returns snapshotVerified=false when previewDataUrl is null", () => {
    const result = deriveBrowserStatus(
      { active: true, activity: null },
      null,
      null,
    );
    assert.equal(result.snapshotVerified, false);
  });

  it("returns failed=true when computerControlError is non-null", () => {
    const result = deriveBrowserStatus(
      { active: true, activity: null },
      "data:image/png;base64,abc",
      "Connection refused",
    );
    assert.deepStrictEqual(result, {
      active: true,
      snapshotVerified: true,
      failed: true,
    });
  });

  it("returns snapshotVerified=true for empty string data URL", () => {
    const result = deriveBrowserStatus(
      { active: false, activity: null },
      "",
      null,
    );
    // Boolean("") is false — empty string is not a valid preview
    assert.equal(result.snapshotVerified, false);
  });
});

describe("deriveConversationPlan", () => {
  it("keeps the durable active-turn plan while a resumed stream has not replayed plan events yet", () => {
    assert.equal(
      deriveConversationPlan({
        isStreaming: true,
        livePlanMarkdown: null,
        projectionLoaded: true,
        projectedPlan: "- [-] durable active plan",
        persistedPlan: "- [x] old persisted plan",
        projectedActiveTurnId: "turn-1",
        streamOwnerTurnId: "turn-1",
      }),
      "- [-] durable active plan",
    );
  });

  it("does not reuse a projected plan for a different streaming turn", () => {
    assert.equal(
      deriveConversationPlan({
        isStreaming: true,
        livePlanMarkdown: null,
        projectionLoaded: true,
        projectedPlan: "- [-] stale projected plan",
        persistedPlan: "- [x] old persisted plan",
        projectedActiveTurnId: "turn-1",
        streamOwnerTurnId: "turn-2",
      }),
      null,
    );
  });

  it("prefers live plan events over projected state during streaming", () => {
    assert.equal(
      deriveConversationPlan({
        isStreaming: true,
        livePlanMarkdown: "- [-] live plan",
        projectionLoaded: true,
        projectedPlan: "- [-] durable active plan",
        persistedPlan: null,
        projectedActiveTurnId: "turn-1",
        streamOwnerTurnId: "turn-1",
      }),
      "- [-] live plan",
    );
  });
});
