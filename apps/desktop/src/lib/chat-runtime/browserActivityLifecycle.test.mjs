import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveBrowserStatus } from "./browserActivityLifecycle.mjs";

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
