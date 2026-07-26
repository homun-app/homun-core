import { describe, expect, it } from "vitest";
import { normalizeKeyName } from "../src/browser/actions.js";

// Regression: the model pressed "Return" to submit a filled search form and Playwright threw
// `Unknown key: "Return"`, so the search never ran and the model kept clicking to make results appear.
describe("normalizeKeyName", () => {
  it("maps everyday key names onto Playwright's vocabulary", () => {
    expect(normalizeKeyName("Return")).toBe("Enter");
    expect(normalizeKeyName("return")).toBe("Enter");
    expect(normalizeKeyName("Esc")).toBe("Escape");
    expect(normalizeKeyName("Down")).toBe("ArrowDown");
    expect(normalizeKeyName("cmd")).toBe("Meta");
  });

  it("normalizes every segment of a combo", () => {
    expect(normalizeKeyName("Control+Return")).toBe("Control+Enter");
    expect(normalizeKeyName("cmd+a")).toBe("Meta+a");
  });

  it("leaves already-valid and unknown keys untouched", () => {
    expect(normalizeKeyName("Enter")).toBe("Enter");
    expect(normalizeKeyName("F5")).toBe("F5");
    expect(normalizeKeyName("a")).toBe("a");
    // Unknown keys must still reach Playwright so it reports a genuine bad key.
    expect(normalizeKeyName("Frobnicate")).toBe("Frobnicate");
  });
});
