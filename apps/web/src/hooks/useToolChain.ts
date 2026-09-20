/** Tool-chain UI state; the durable chain and step records remain on the engine. */
import { useEffect, useRef, useState } from "react";
import type { Work } from "@/components/builder/conversation-types";
import {
  approveToolChain,
  listToolChains,
  proposeToolChain,
  type ToolChain,
} from "@/lib/engine-tool-chain-client";

export function useToolChain(work: Work, onChanged: () => Promise<void>) {
  const [chain, setChain] = useState<ToolChain | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const operation = useRef(crypto.randomUUID());
  const approval = useRef(crypto.randomUUID());
  const finished = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const items = await listToolChains(work.id);
        if (!live) return;
        const next = items.at(-1) ?? null;
        setChain(next);
        if (next?.status === "completed" && finished.current !== next.id) {
          finished.current = next.id;
          await callback.current();
        }
        if (next && ["queued", "running"].includes(next.status))
          timer = setTimeout(() => void read(), 1500);
      } catch (cause) {
        if (live) setError(cause);
      }
    }
    void read();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [work.id, chain?.status]);
  async function propose(materialIds: string[]) {
    if (busy || materialIds.length < 2) return;
    setBusy(true);
    setError(null);
    try {
      setChain(await proposeToolChain(work, materialIds, operation.current));
      await callback.current();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (!chain || busy) return;
    setBusy(true);
    setError(null);
    try {
      setChain(await approveToolChain(work.id, chain, approval.current));
      await callback.current();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return {
    chain,
    busy,
    error,
    propose,
    approve,
    newChain: () => {
      operation.current = crypto.randomUUID();
      approval.current = crypto.randomUUID();
    },
  };
}
