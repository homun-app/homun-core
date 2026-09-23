/** Shared durable proposal/approval polling and conflict recovery. */
import { useEffect, useRef, useState } from "react";
import type { Work } from "@/components/builder/conversation-types";
import { useConflictRecovery } from "./useConflictRecovery";

type Proposal = { id: string; status: string };
type Transport<T, A extends unknown[]> = {
  list: (workId: string) => Promise<T[]>;
  prepare: (work: Work, operationId: string, ...args: A) => Promise<T>;
  approve: (workId: string, proposal: T, commandId: string) => Promise<T>;
};
export function useEngineExecution<T extends Proposal, A extends unknown[]>(
  work: Work, onChanged: () => Promise<void>, transport: Transport<T, A>,
) {
  const api = useRef(transport);
  api.current = transport;
  const [items, setItems] = useState<T[]>([]);
  const [proposal, setProposal] = useState<T | null>(null);
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
        const found = await api.current.list(work.id);
        if (!live) return;
        const visible = found.filter((item) => !conflict.isRejected(item.id));
        const next = visible.at(-1) ?? null;
        setItems(visible);
        setProposal(next);
        if (next && ["completed", "waiting_input", "failed", "blocked"].includes(next.status) && finished.current !== `${next.id}:${next.status}`) {
          finished.current = `${next.id}:${next.status}`;
          if (["completed", "failed", "blocked"].includes(next.status)) renew();
          await callback.current();
        }
        if (next && ["queued", "running", "waiting_input"].includes(next.status))
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
  async function prepare(...args: A) {
    setBusy(true);
    setError(null);
    conflict.clear();
    try {
      setProposal(await api.current.prepare(work, operation.current, ...args));
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
      setProposal(await api.current.approve(work.id, proposal, approval.current));
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
