/**
 * Shared hook applying the conflict-recovery policy for tool actions
 * (prepare/approve). On a stale-version 409 it refreshes the engine state,
 * renews the operation ids (the retry must be a fresh command) and exposes the
 * guided message. Returns false when the cause is something else — or the
 * refresh itself failed — so the caller keeps the typed error visible.
 */
import { useRef, useState } from "react";
import { planConflictRecovery } from "@/lib/engine-conflict-recovery";

export function useConflictRecovery(options: {
  refresh: () => Promise<void>;
  renewOperation: () => void;
  /** Guidance differs: a rejected approve must be prepared again, not repeated. */
  action?: "prepare" | "approve";
}) {
  const [recovery, setRecovery] = useState<string | null>(null);
  const rejectedId = useRef<string | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  async function handle(
    cause: unknown,
    action: "prepare" | "approve" = optionsRef.current.action ?? "prepare",
    rejected?: string,
  ): Promise<boolean> {
    const plan = planConflictRecovery(cause, action);
    if (plan.kind === "none") return false;
    optionsRef.current.renewOperation();
    if (action === "approve" && rejected) rejectedId.current = rejected;
    try {
      await optionsRef.current.refresh();
      setRecovery(plan.message);
      return true;
    } catch {
      // The state could not be refreshed: the original conflict error stays
      // visible rather than a promise of fresh data we do not have.
      return false;
    }
  }
  /** A proposal whose approve was rejected on a stale version is permanently
   *  unapprovable: hide it so the person can prepare the action again. */
  function isRejected(id: string | null | undefined): boolean {
    return id != null && rejectedId.current === id;
  }
  function clear() {
    setRecovery(null);
  }
  return { recovery, handle, isRejected, clear };
}
