/** Synthesis UI state; the durable proposal, approval and execution stay on the engine. */
import { useEffect, useRef, useState } from "react";
import type { Work } from "@/components/builder/conversation-types";
import {
  approveSynthesis,
  listSyntheses,
  prepareSynthesis,
  type SynthesisProposal,
} from "@/lib/engine-synthesis-client";
import { useConflictRecovery } from "./useConflictRecovery";

export function useSynthesis(work: Work, onChanged: () => Promise<void>) {
  const [items, setItems] = useState<SynthesisProposal[]>([]);
  const [proposal, setProposal] = useState<SynthesisProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const operation = useRef(crypto.randomUUID());
  const approval = useRef(crypto.randomUUID());
  const finished = useRef<string | null>(null);
  const renew = () => {
    operation.current = crypto.randomUUID();
    approval.current = crypto.randomUUID();
  };
  const conflict = useConflictRecovery({
    refresh: () => callback.current(),
    renewOperation: renew,
  });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const found = await listSyntheses(work.id);
        if (!live) return;
        const visible = found.filter((item) => !conflict.isRejected(item.id));
        const next = visible.at(-1) ?? null;
        setItems(visible);
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
  }, [work.id, work.revision, proposal?.status]);
  async function prepare(materialIds: string[], skillIds: string[] = []) {
    setBusy(true);
    setError(null);
    conflict.clear();
    try {
      setProposal(await prepareSynthesis(work, materialIds, operation.current, skillIds));
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
      setProposal(await approveSynthesis(work.id, proposal, approval.current));
      await callback.current();
    } catch (cause) {
      if (await conflict.handle(cause, "approve", proposal.id)) {
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
    items,
    busy,
    error,
    recovery: conflict.recovery,
    prepare,
    approve,
    renew,
  };
}
