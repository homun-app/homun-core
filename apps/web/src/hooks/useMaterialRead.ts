/** Tool-specific UI state; the durable proposal and execution remain on the engine. */
import { useEffect, useRef, useState } from "react";
import type { Work } from "@/components/builder/conversation-types";
import {
  approveMaterialRead,
  listMaterialReads,
  prepareMaterialRead,
  prepareReadFromMaterial,
  type MaterialRead,
} from "@/lib/engine-material-read-client";
import { useConflictRecovery } from "./useConflictRecovery";

export function useMaterialRead(work: Work, onChanged: () => Promise<void>) {
  const [reads, setReads] = useState<MaterialRead[]>([]);
  const [proposal, setProposal] = useState<MaterialRead | null>(null);
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
        const items = await listMaterialReads(work.id);
        if (!live) return;
        const visible = items.filter((item) => !conflict.isRejected(item.id));
        const next = visible.at(-1) ?? null;
        setReads(visible);
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
  async function prepare(file: File) {
    setBusy(true);
    setError(null);
    conflict.clear();
    try {
      setProposal(await prepareMaterialRead(work, file, operation.current));
      await callback.current();
    } catch (cause) {
      if (!(await conflict.handle(cause))) setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function prepareFromMaterial(materialId: string) {
    setBusy(true);
    setError(null);
    conflict.clear();
    try {
      setProposal(await prepareReadFromMaterial(work, materialId, operation.current));
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
      setProposal(await approveMaterialRead(work.id, proposal, approval.current));
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
    reads,
    busy,
    error,
    recovery: conflict.recovery,
    prepare,
    prepareFromMaterial,
    approve,
    newFiles,
  };
}
