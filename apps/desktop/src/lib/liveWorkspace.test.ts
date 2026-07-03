import { describe, expect, it } from "vitest";
import type { ChatEventPart } from "../types";
import { applyLiveEvent, EMPTY_LIVE_WORKSPACE } from "./liveWorkspace";

const plan = (markdown: string): ChatEventPart => ({ type: "plan_update", markdown });
const act = (text: string): ChatEventPart => ({ type: "activity", text });

describe("applyLiveEvent", () => {
  it("plan_update replaces the plan with the full markdown", () => {
    const s1 = applyLiveEvent(EMPTY_LIVE_WORKSPACE, plan("🎯 goal\n- step 1"));
    expect(s1.plan).toBe("🎯 goal\n- step 1");
    const s2 = applyLiveEvent(s1, plan("🎯 goal\n- step 1 ✓\n- step 2"));
    expect(s2.plan).toBe("🎯 goal\n- step 1 ✓\n- step 2");
  });

  it("empty/blank plan_update keeps the prior plan (parity with latestPlanMarkdown → null on empty)", () => {
    const s1 = applyLiveEvent(EMPTY_LIVE_WORKSPACE, plan("real plan"));
    expect(applyLiveEvent(s1, plan("")).plan).toBe("real plan");
    expect(applyLiveEvent(s1, plan("   ")).plan).toBe("real plan");
    expect(applyLiveEvent(EMPTY_LIVE_WORKSPACE, plan("")).plan).toBeNull();
  });

  it("activity appends trimmed step labels in order (parity with parseActivitySteps)", () => {
    let s = applyLiveEvent(EMPTY_LIVE_WORKSPACE, act("  🌐 Apro la pagina  "));
    s = applyLiveEvent(s, act("👁️ Leggo la pagina"));
    expect(s.activity).toEqual(["🌐 Apro la pagina", "👁️ Leggo la pagina"]);
  });

  it("blank activity is dropped (parseActivitySteps filters empties)", () => {
    const s = applyLiveEvent(EMPTY_LIVE_WORKSPACE, act("   "));
    expect(s.activity).toEqual([]);
  });

  it("unrelated event types are a no-op (same reference returned)", () => {
    const base = applyLiveEvent(EMPTY_LIVE_WORKSPACE, plan("p"));
    const after = applyLiveEvent(base, { type: "reasoning", text: "thinking" });
    expect(after).toBe(base);
  });
});
