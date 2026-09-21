/** Tool-specific UI state; the durable proposal and execution remain on the engine. */
import { useEffect, useRef, useState } from "react";
import type { Work } from "@/components/builder/conversation-types";
import {
  approvePriceComparison,
  listPriceComparisons,
  prepareComparisonFromMaterials,
  preparePriceComparison,
  type PriceComparison,
} from "@/lib/engine-price-comparison-client";
import { useConflictRecovery } from "./useConflictRecovery";
export function usePriceComparison(work: Work, onChanged: () => Promise<void>) {
  const [proposal, setProposal] = useState<PriceComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const operation = useRef(crypto.randomUUID());
  const approval = useRef(crypto.randomUUID());
  const finished = useRef<string | null>(null);
  const newFiles = () => {
    operation.current = crypto.randomUUID();
    approval.current = crypto.randomUUID();
  };
  const conflict = useConflictRecovery({
    refresh: () => callback.current(),
    renewOperation: newFiles,
  });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const items = await listPriceComparisons(work.id);
        if (!live) return;
        const next =
          items.filter((item) => !conflict.isRejected(item.id)).at(-1) ?? null;
        setProposal(next);
        if (next?.status === "completed" && finished.current !== next.id) {
          finished.current = next.id;
          await callback.current();
        }
        if (next && ["queued", "running"].includes(next.status))
          timer = setTimeout(() => void read(), 1000);
      } catch (cause) {
        if (live) {
          setProposal(null);
          setError(cause);
        }
      }
    }
    void read();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [work.id, proposal?.status]);
  async function prepare(left: File, right: File) {
    setBusy(true);
    setError(null);
    conflict.clear();
    try {
      setProposal(await preparePriceComparison(work, left, right, operation.current));
      await callback.current();
    } catch (cause) {
      if (!(await conflict.handle(cause))) setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function prepareFromMaterials(leftId: string, rightId: string) {
    setBusy(true);
    setError(null);
    conflict.clear();
    try {
      setProposal(await prepareComparisonFromMaterials(work, leftId, rightId, operation.current));
      await callback.current();
    } catch (cause) {
      if (!(await conflict.handle(cause))) setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    conflict.clear();
    try {
      setProposal(await approvePriceComparison(work.id, proposal, approval.current));
      await callback.current();
    } catch (cause) {
      if (await conflict.handle(cause, "approve", proposal.id)) {
        // The rejected proposal is permanently unapprovable: back to selection.
        setProposal(null);
      } else {
        setError(cause);
      }
    } finally {
      setBusy(false);
    }
  }
  return {
    proposal,
    busy,
    error,
    recovery: conflict.recovery,
    prepare,
    prepareFromMaterials,
    approve,
    newFiles,
  };
}
