import { describe, expect, it } from "vitest";
import {
  appendFormHintText,
  buildPageStatsHeader,
  markNewRefsInText,
  type PageStatsAndFormHints,
} from "../src/browser/snapshot.js";
import { requireRef } from "../src/browser/actions.js";
import type { Locator } from "playwright-core";

// ---------------------------------------------------------------------------
// Fase 2.1 — page stats header
// ---------------------------------------------------------------------------
describe("buildPageStatsHeader", () => {
  const base = (overrides: Partial<PageStatsAndFormHints>): PageStatsAndFormHints => ({
    scrollY: 0,
    scrollHeight: 1000,
    clientHeight: 500,
    interactiveCount: 12,
    totalElements: 300,
    selectOptions: [],
    dateInputs: [],
    ...overrides,
  });

  it("produces a single-line header with interactive count, pages below, and total elements", () => {
    const header = buildPageStatsHeader(
      base({ scrollY: 0, scrollHeight: 2000, clientHeight: 500, interactiveCount: 25, totalElements: 800 }),
    );
    expect(header).toBe("[page: 25 interactive | scroll: 3.0 pages below | 800 total]");
    // Must be a single line (no newlines).
    expect(header.split("\n")).toHaveLength(1);
  });

  it("reports 0.0 pages below when page fits entirely in viewport", () => {
    const header = buildPageStatsHeader(
      base({ scrollY: 0, scrollHeight: 400, clientHeight: 500 }),
    );
    expect(header).toContain("scroll: 0.0 pages below");
  });

  it("accounts for current scroll position in pages below", () => {
    // scrolled halfway: (2000 - 500 - 750) / 500 = 1.5
    const header = buildPageStatsHeader(
      base({ scrollY: 750, scrollHeight: 2000, clientHeight: 500 }),
    );
    expect(header).toContain("scroll: 1.5 pages below");
  });

  it("clamps to 0 when scrolled past the bottom", () => {
    const header = buildPageStatsHeader(
      base({ scrollY: 2000, scrollHeight: 2000, clientHeight: 500 }),
    );
    expect(header).toContain("scroll: 0.0 pages below");
  });
});

// ---------------------------------------------------------------------------
// Fase 2.2 — new-ref `*` suffix
// ---------------------------------------------------------------------------
describe("markNewRefsInText", () => {
  it("adds * suffix to refs in the newRefs set", () => {
    const text = '- button "Submit" [ref=e1]\n- link "Home" [ref=e2]';
    const marked = markNewRefsInText(text, new Set(["e2"]));
    expect(marked).toBe('- button "Submit" [ref=e1]\n- link "Home" [ref=e2*]');
  });

  it("leaves text unchanged when newRefs is empty", () => {
    const text = '- button "Go" [ref=e1]';
    expect(markNewRefsInText(text, new Set())).toBe(text);
  });

  it("marks multiple new refs in a single snapshot", () => {
    const text = '- button "A" [ref=e1]\n- button "B" [ref=e2]\n- button "C" [ref=e3]';
    const marked = markNewRefsInText(text, new Set(["e1", "e3"]));
    expect(marked).toBe('- button "A" [ref=e1*]\n- button "B" [ref=e2]\n- button "C" [ref=e3*]');
  });

  it("does not double-mark already-starred refs", () => {
    // If somehow text already contains a *, the regex excludes * from the
    // capture group so it won't match.
    const text = '- button "X" [ref=e1*]';
    const marked = markNewRefsInText(text, new Set(["e1"]));
    // The `*` in the original makes the ref not match the pattern `[^\]\s*]+`.
    expect(marked).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Fase 2.2 — requireRef strips * suffix
// ---------------------------------------------------------------------------
describe("requireRef strips * suffix", () => {
  it("resolves a locator when ref has a trailing *", () => {
    const fakeLocator = { fake: true } as unknown as Locator;
    const refs = new Map<string, Locator>();
    refs.set("e5", fakeLocator);
    expect(requireRef(refs, "e5*")).toBe(fakeLocator);
  });

  it("resolves a locator when ref has no *", () => {
    const fakeLocator = { fake: true } as unknown as Locator;
    const refs = new Map<string, Locator>();
    refs.set("e5", fakeLocator);
    expect(requireRef(refs, "e5")).toBe(fakeLocator);
  });

  it("throws when stripped ref is not in the map", () => {
    const refs = new Map<string, Locator>();
    expect(() => requireRef(refs, "e99*")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fase 2.3 — form hints (select options, date format)
// ---------------------------------------------------------------------------
describe("appendFormHintText", () => {
  const noHints: PageStatsAndFormHints = {
    scrollY: 0, scrollHeight: 0, clientHeight: 0,
    interactiveCount: 0, totalElements: 0,
    selectOptions: [], dateInputs: [],
  };

  it("appends select options to matching combobox lines", () => {
    const snapshot = '- combobox "Country" [ref=e1]\n- button "Submit" [ref=e2]';
    const hints: PageStatsAndFormHints = {
      ...noHints,
      selectOptions: [{ label: "Country", options: ["US", "UK", "IT", "DE", "FR"] }],
    };
    const result = appendFormHintText(snapshot, hints);
    expect(result).toContain('- combobox "Country" [ref=e1] (options: US | UK | IT | DE | FR)');
    // Non-matching line is untouched.
    expect(result).toContain('- button "Submit" [ref=e2]');
  });

  it("appends date format hint to matching textbox lines", () => {
    const snapshot = '- textbox "Birth date" [ref=e3]';
    const hints: PageStatsAndFormHints = {
      ...noHints,
      dateInputs: [{ label: "Birth date", format: "YYYY-MM-DD" }],
    };
    const result = appendFormHintText(snapshot, hints);
    expect(result).toBe('- textbox "Birth date" [ref=e3] (format: YYYY-MM-DD)');
  });

  it("appends datetime-local format hint", () => {
    const snapshot = '- textbox "Appointment" [ref=e4]';
    const hints: PageStatsAndFormHints = {
      ...noHints,
      dateInputs: [{ label: "Appointment", format: "YYYY-MM-DDTHH:MM" }],
    };
    const result = appendFormHintText(snapshot, hints);
    expect(result).toBe('- textbox "Appointment" [ref=e4] (format: YYYY-MM-DDTHH:MM)');
  });

  it("returns text unchanged when there are no hints", () => {
    const snapshot = '- combobox "X" [ref=e1]';
    expect(appendFormHintText(snapshot, noHints)).toBe(snapshot);
  });

  it("matches case-insensitively", () => {
    const snapshot = '- combobox "country" [ref=e1]';
    const hints: PageStatsAndFormHints = {
      ...noHints,
      selectOptions: [{ label: "Country", options: ["A", "B"] }],
    };
    const result = appendFormHintText(snapshot, hints);
    expect(result).toContain("(options: A | B)");
  });
});
