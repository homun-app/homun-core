import { useEffect, useState } from "react";
import { coreBridge } from "../lib/coreBridge";

const PLAN_STEP_PULSE_MS = 2400;

/** Tracks the plan step a kernel `step_advance` event just touched, so the
 *  workspace island can briefly pulse the matching row. Returns the step id or
 *  null; the pulse auto-clears after a short window. */
export function usePlanStepPulse(): string | null {
  const [pulseStepId, setPulseStepId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;

    void coreBridge.listenChatStreamEvent((event) => {
      if (event.type !== "step_advance") return;
      setPulseStepId(event.payload.step_id);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setPulseStepId(null), PLAN_STEP_PULSE_MS);
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  return pulseStepId;
}
