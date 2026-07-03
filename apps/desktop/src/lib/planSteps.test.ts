import { describe, expect, it } from "vitest";
import { planStepIndicator } from "./planSteps";

describe("planStepIndicator", () => {
  it("done is always done, regardless of streaming", () => {
    expect(planStepIndicator("done", true)).toBe("done");
    expect(planStepIndicator("done", false)).toBe("done");
  });

  it("a doing step is RUNNING while the turn streams (shows a spinner)", () => {
    expect(planStepIndicator("doing", true)).toBe("running");
  });

  it("a doing step left open after the turn ends is INCOMPLETE, not running", () => {
    // The core fix: a finalized turn with an open step must not look like it's
    // still working ("stuck") — it's honestly incomplete.
    expect(planStepIndicator("doing", false)).toBe("incomplete");
  });

  it("blocked is blocked regardless of streaming", () => {
    expect(planStepIndicator("blocked", true)).toBe("blocked");
    expect(planStepIndicator("blocked", false)).toBe("blocked");
  });

  it("todo is pending regardless of streaming", () => {
    expect(planStepIndicator("todo", true)).toBe("pending");
    expect(planStepIndicator("todo", false)).toBe("pending");
  });
});
