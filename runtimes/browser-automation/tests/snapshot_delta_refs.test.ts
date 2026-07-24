import { describe, expect, it } from "vitest";
import { structuralDelta } from "../src/browser/snapshot.js";

// WHY these tests exist: `createAiSnapshot` may re-parse refs out of the
// *observed* snapshot text (`refsFromAiSnapshot`) when a role filter is
// active. In `observationMode === "delta"` the observed text is NOT a
// snapshot — it is `+`/`-`-prefixed diff text, so that re-parse silently
// returns the wrong ref set. These tests pin the delta line format that
// makes it wrong, so the guard in `createAiSnapshot` (refs always come
// from the full built snapshot in delta mode) can never be "simplified"
// away by a future refactor.
//
// Kept in sync by construction with the regex in `snapshot.ts`
// (`refsFromAiSnapshot`), which is module-private and therefore mirrored
// here rather than imported.
const REF_LINE = /^\s*-\s*([a-zA-Z][\w-]*)(?:\s+"([^"]*)")?.*\[ref=([^\]\s]+)\]/;

function parseRefs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.match(REF_LINE))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[3]);
}

describe("delta observation never yields parseable refs", () => {
  it("prefixes every delta line so the ref regex cannot match it", () => {
    const previous = `- button "Pay" [ref=e1]`;
    const current = `- button "Pay" [ref=e1]\n- button "Cancel" [ref=e2]`;
    const delta = structuralDelta(previous, current);
    // The ref regex anchors on `^\s*-`; a delta line starts with `+ ` or `- `
    // followed by the original `- `. Any line that still looks like a raw
    // snapshot line would be silently parsed as a live ref.
    for (const line of delta.split("\n").filter(Boolean)) {
      expect(line.startsWith("+ ") || line.startsWith("- ")).toBe(true);
    }
    expect(delta).toContain("Cancel");
  });

  it("loses every live ref when the delta text is parsed as a snapshot", () => {
    // The concrete damage of re-parsing a delta: the page still exposes e2
    // and e3, but neither survives the round-trip, so the caller would hand
    // the model an observation with an empty ref set (no locators, nothing
    // clickable) while believing it had parsed the page.
    const previous = ['- button "Pay" [ref=e1]', '- heading "Cart" [ref=e2]'].join("\n");
    const current = ['- heading "Cart" [ref=e2]', '- button "Continue" [ref=e3]'].join("\n");

    const delta = structuralDelta(previous, current);

    expect(parseRefs(current)).toEqual(["e2", "e3"]);
    expect(parseRefs(delta)).toEqual([]);
  });

  it("keeps a removed line's dead ref unparseable via the doubled `- ` marker", () => {
    // The removal marker is what stops a ref that no longer exists on the
    // page from being resurrected: `- ` + the original `- ` yields `- - `,
    // and the regex's role token (`[a-zA-Z][\w-]*`) cannot match the second
    // dash. Change the marker to something the regex tolerates and a delta
    // starts advertising dead refs as live — hence the guard upstream rather
    // than reliance on this coincidence.
    const previous = ['- button "Pay" [ref=e1]', '- heading "Cart" [ref=e2]'].join("\n");
    const current = ['- heading "Cart" [ref=e2]'].join("\n");

    const delta = structuralDelta(previous, current);
    const removedLine = delta.split("\n").find((line) => line.includes("[ref=e1]"));

    expect(removedLine).toBe('- - button "Pay" [ref=e1]');
    expect(parseRefs(delta)).toEqual([]);
  });
});
