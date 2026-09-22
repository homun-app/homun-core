import { useCallback, useEffect, useRef, useState } from "react";
import type { Work } from "@/components/builder/conversation-types";
import { isHomunClientError } from "@/lib/homun-errors";
import {
  confirmWorkIntake,
  listWorkIntakes,
  proposeWorkIntake,
  type WorkIntake,
} from "@/lib/engine-intake-client";

export type WorkIntakeState = {
  proposal: WorkIntake | null;
  loaded: boolean;
  busy: boolean;
  error: unknown;
  confirm: () => Promise<void>;
  refine: (text: string) => Promise<boolean>;
};

/**
 * Single owner of a work's latest brief: chat card, right panel and sidebar
 * projection all read this instance. Null work (simulation mode) idles.
 */
export function useWorkIntake(
  work: Work | null,
  onChanged: () => Promise<void>,
  reloadSeq = 0,
): WorkIntakeState {
  const [proposal, setProposal] = useState<WorkIntake | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const approval = useRef(crypto.randomUUID());
  const workId = work?.id ?? null;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!workId) return null;
      const list = await listWorkIntakes(workId, signal);
      if (!signal?.aborted) {
        setProposal(list.at(-1) ?? null);
        setLoaded(true);
      }
      return list.at(-1) ?? null;
    },
    [workId],
  );
  // A work switch must never flash the previous work's brief.
  useEffect(() => {
    approval.current = crypto.randomUUID();
    setProposal(null);
    setError(null);
  }, [workId]);
  useEffect(() => {
    if (!workId) {
      setLoaded(true);
      return;
    }
    const controller = new AbortController();
    // Refresh an existing agreement in place: resetting state here would make
    // the brief flash on every message; unmounting instead would reset
    // completion tracking and cause intake refresh loops.
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
  }, [refresh, workId, work?.revision, work?.messages.length, reloadSeq]);
  async function confirm() {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      setProposal(
        await confirmWorkIntake(proposal.work_id, proposal, approval.current, Boolean(proposal.new_agent)),
      );
      await callback.current();
    } catch (cause) {
      // A 404 after an engine restart or a 409 on a stale expected_version mean
      // the cached proposal is dead: refresh the intake list instead of showing
      // a dead-end error. The fresh proposal is the guided recovery — the person
      // confirms again on current data.
      if (isHomunClientError(cause) && (cause.code === "not_found" || cause.code === "version_conflict")) {
        setProposal(null);
        setError(null);
        try {
          const list = await listWorkIntakes(proposal.work_id);
          setProposal(list.at(-1) ?? null);
        } catch {
          setError(cause);
        }
      } else {
        setError(cause);
      }
    } finally {
      setBusy(false);
    }
  }
  async function refine(text: string) {
    if (!work || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const next = await proposeWorkIntake(work.id, text, work.revision, crypto.randomUUID());
      setProposal(next);
      approval.current = crypto.randomUUID();
      await callback.current();
      return next.status !== "failed";
    } catch (cause) {
      if (isHomunClientError(cause) && cause.code === "not_found") {
        // Stale work after engine restart: clear and let the effect re-fetch.
        setProposal(null);
        setError(null);
      } else {
        setError(cause);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { proposal, loaded, busy, error, confirm, refine };
}
