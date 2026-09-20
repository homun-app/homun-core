import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatInterpretationForUi,
  parseInterpretation,
  parseWorkPatchProposal,
} from "../apps/web/src/lib/interpretation-display.ts";

describe("formatInterpretationForUi", () => {
  it("formats reply text", () => {
    assert.equal(
      formatInterpretationForUi({ kind: "reply", text: "Ciao", mentions: [] }),
      "Ciao",
    );
  });

  it("marks command proposals toward plan draft", () => {
    const text = formatInterpretationForUi({
      kind: "command_proposal",
      text: null,
      command: { type: "work.assign", payload: {}, summary: "Assegna a Vera" },
      mentions: [],
    });
    assert.match(text, /Assegna a Vera/);
    assert.match(text, /F3\.3/);
  });

  it("marks patch proposals for confirm card", () => {
    const text = formatInterpretationForUi({
      kind: "patch_proposal",
      text: "Propongo aggiornamento",
      mentions: [],
    });
    assert.match(text, /Propongo aggiornamento/);
    assert.match(text, /Conferma/);
  });
});

describe("parseInterpretation", () => {
  it("returns null for invalid payloads", () => {
    assert.equal(parseInterpretation(null), null);
    assert.equal(parseInterpretation({ kind: "nope" }), null);
  });

  it("parses a valid clarification", () => {
    const parsed = parseInterpretation({
      kind: "clarification",
      text: "Chi?",
      mentions: [{ raw: "@Alex", candidates: [{ id: "a1", display_name: "Alex", kind: "person" }] }],
    });
    assert.ok(parsed);
    assert.equal(parsed.kind, "clarification");
    assert.equal(parsed.mentions[0]?.candidates[0]?.id, "a1");
  });

  it("parses patch_proposal kind", () => {
    const parsed = parseInterpretation({
      kind: "patch_proposal",
      text: "Modifica",
      mentions: [],
    });
    assert.ok(parsed);
    assert.equal(parsed.kind, "patch_proposal");
  });
});

describe("parseWorkPatchProposal", () => {
  it("parses a valid proposal", () => {
    const parsed = parseWorkPatchProposal({
      work_id: "work_1",
      base_version: 2,
      changes: [{ field: "objective", from_value: "A", to_value: "B" }],
      summary_lines: ["Obiettivo: «A» → «B»"],
      missing_or_ambiguous: [],
    });
    assert.ok(parsed);
    assert.equal(parsed.work_id, "work_1");
    assert.equal(parsed.changes[0]?.to_value, "B");
  });

  it("rejects proposals with validation issues", () => {
    assert.equal(
      parseWorkPatchProposal({
        work_id: "work_1",
        base_version: 1,
        changes: [{ field: "owner_id", to_value: "ghost" }],
        summary_lines: [],
        missing_or_ambiguous: ["owner_id unknown: ghost"],
      }),
      null,
    );
  });
});
