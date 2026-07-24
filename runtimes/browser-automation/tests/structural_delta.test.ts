import { describe, expect, it } from "vitest";
import { structuralDelta } from "../src/browser/snapshot.js";

// Sequence-aware structuralDelta (IMPORTANT 4 / build1 B3). The naive
// predecessor did set-membership on trimmed lines: it only ever reported
// ADDED lines (removals were invisible), deduplicated genuinely-new
// duplicate lines away, and collapsed under Playwright ref reassignment
// (every line differs -> the "delta" becomes the whole page). These tests
// pin the sequence-diff replacement's four required behaviors.
describe("structuralDelta", () => {
  it("returns the full snapshot when there is no previous observation", () => {
    const current = '- heading "Welcome" [ref=e1]\n- button "Go" [ref=e2]';
    expect(structuralDelta(undefined, current)).toBe(current);
  });

  it("surfaces a removed line, marked, when content disappears", () => {
    const previous = [
      '- alert "Payment failed" [ref=e1]',
      '- heading "Checkout" [ref=e2]',
      '- button "Retry" [ref=e3]',
    ].join("\n");
    const current = ['- heading "Checkout" [ref=e2]', '- button "Retry" [ref=e3]'].join("\n");

    const delta = structuralDelta(previous, current);

    expect(delta).toContain('- alert "Payment failed" [ref=e1]');
    // Marked as removed, not silently dropped and not reported as an add.
    const removedLine = delta.split("\n").find((line) => line.includes("Payment failed"));
    expect(removedLine).toMatch(/^- /);
    expect(delta).not.toContain("[no structural changes detected]");
  });

  it("keeps a genuinely-new duplicate line instead of dropping it as already-seen", () => {
    const previous = ['- text "In stock" [ref=e1]', '- heading "Item A" [ref=e2]'].join("\n");
    const current = [
      '- text "In stock" [ref=e1]',
      '- heading "Item A" [ref=e2]',
      '- text "In stock" [ref=e3]',
    ].join("\n");

    const delta = structuralDelta(previous, current);

    // The new, third "In stock" line (a real duplicate by text) must be
    // reported as an addition, not filtered out via set membership.
    const addedLines = delta.split("\n").filter((line) => line.startsWith("+ "));
    expect(addedLines).toContainEqual('+ - text "In stock" [ref=e3]');
  });

  it("falls back to the full snapshot when ref churn defeats line-identity", () => {
    const previous = Array.from(
      { length: 20 },
      (_, i) => `- button "Item ${i}" [ref=e${i + 1}]`,
    ).join("\n");
    // Same visible content, but Playwright reassigned every ref (e.g. after
    // a re-render), so every single line differs from the previous ones.
    const current = Array.from(
      { length: 20 },
      (_, i) => `- button "Item ${i}" [ref=e${i + 101}]`,
    ).join("\n");

    const delta = structuralDelta(previous, current);

    expect(delta).toBe(current);
    expect(delta).not.toBe("[no structural changes detected]");
    // Not a "delta" that just restates the whole page with + markers either.
    expect(delta).not.toContain("+ ");
  });

  it("reports a clear no-op message when nothing structurally changed", () => {
    const snapshot = ['- heading "Welcome" [ref=e1]', '- button "Go" [ref=e2]'].join("\n");

    expect(structuralDelta(snapshot, snapshot)).toBe("[no structural changes detected]");
  });
});
