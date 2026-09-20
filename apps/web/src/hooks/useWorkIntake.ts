import { useCallback, useEffect, useRef, useState } from "react";
import type { Work } from "@/components/builder/conversation-types";
import {
  confirmWorkIntake,
  listWorkIntakes,
  proposeWorkIntake,
  type WorkIntake,
} from "@/lib/engine-intake-client";
export function useWorkIntake(work: Work, onChanged: () => Promise<void>) {
  const [proposal, setProposal] = useState<WorkIntake | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const approval = useRef(crypto.randomUUID());
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const list = await listWorkIntakes(work.id, signal);
      if (!signal?.aborted) {
        setProposal(list.at(-1) ?? null);
        setLoaded(true);
      }
      return list.at(-1) ?? null;
    },
    [work.id],
  );
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    // This hook is keyed by work ID in the chat stage. Refresh an existing
    // agreement in place: unmounting its tool resets completion tracking and
    // causes completion -> inventory -> transcript -> intake refresh loops.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let remaining = 60;
    async function read() {
      try {
        const latest = await refresh(controller.signal);
        if (
          !controller.signal.aborted &&
          latest?.error_code === "intake_interrupted" &&
          remaining-- > 0
        )
          timer = setTimeout(() => void read(), 2000);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setProposal(null);
          setError(cause);
          setLoaded(true);
        }
      }
    }
    void read();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [refresh, work.revision, work.messages.length]);
  async function confirm() {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      setProposal(
        await confirmWorkIntake(work.id, proposal, approval.current, Boolean(proposal.new_agent)),
      );
      await callback.current();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function refine(text: string) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const next = await proposeWorkIntake(work.id, text, work.revision, crypto.randomUUID());
      setProposal(next);
      approval.current = crypto.randomUUID();
      await callback.current();
      return next.status !== "failed";
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { proposal, loaded, busy, error, confirm, refine };
}
