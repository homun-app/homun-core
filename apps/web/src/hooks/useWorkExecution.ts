import { useCallback, useEffect, useRef, useState } from "react";

import type { AutonomyLevel } from "@/components/builder/conversation-preferences";
import {
  EXECUTION_IN_FLIGHT,
  approveExecution,
  getWorkExecution,
  reviewWorkResult,
  startWork,
  type WorkExecution,
} from "@/lib/engine-work-execution-client";

export type WorkExecutionState = {
  execution: WorkExecution | null;
  busy: boolean;
  error: unknown;
  /** Avvia il lavoro confermato: il motore sceglie l'esecutore. */
  start: () => Promise<void>;
  /** «Avvia» su un'esecuzione in attesa del via libera. */
  approve: () => Promise<void>;
  /** Approva il risultato, o chiede una correzione e riavvia nella stessa modalità. */
  review: (decision: "approve" | "request_changes", comment?: string) => Promise<void>;
  reload: () => Promise<void>;
};

const POLL_MS = 1500;

/**
 * Stato dell'esecuzione del lavoro di una conversazione, letto dal motore.
 * Rilegge mentre il motore lavora (in coda / in corso); altrimenti solo su
 * azione o quando cambia `reloadKey` (conferma, nuovi messaggi).
 */
export function useWorkExecution(
  workId: string | null,
  mode: AutonomyLevel,
  reloadKey: unknown,
  onChanged?: () => Promise<void>,
): WorkExecutionState {
  const [execution, setExecution] = useState<WorkExecution | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const reload = useCallback(async () => {
    if (!workId) return;
    setExecution(await getWorkExecution(workId));
  }, [workId]);

  useEffect(() => {
    setExecution(null);
    setError(null);
  }, [workId]);

  useEffect(() => {
    if (!workId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const current = await getWorkExecution(workId as string, controller.signal);
        if (controller.signal.aborted) return;
        setExecution(current);
        if (EXECUTION_IN_FLIGHT.includes(current.status)) {
          timer = setTimeout(() => void read(), POLL_MS);
        } else {
          void changed.current?.();
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause);
      }
    }
    void read();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [workId, reloadKey, execution?.status, execution?.id]);

  async function act(action: () => Promise<unknown>) {
    if (!workId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      await changed.current?.();
    } catch (cause) {
      setError(cause);
      // Lo stato autorevole resta quello del motore, anche dopo un errore.
      await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  return {
    execution,
    busy,
    error,
    reload,
    start: () => act(() => startWork(workId as string, mode)),
    approve: () =>
      act(async () => {
        const current = execution;
        if (!current?.id || !current.digest || current.expected_version == null) return;
        await approveExecution(workId as string, {
          id: current.id,
          digest: current.digest,
          expected_version: current.expected_version,
        });
      }),
    review: (decision, comment) =>
      act(async () => {
        const current = execution;
        if (!current?.artifact) return;
        await reviewWorkResult({
          workId: workId as string,
          expectedVersion: current.work_version,
          artifactId: current.artifact.id,
          decision,
          ...(comment ? { comment } : {}),
        });
        // Una correzione riparte nella stessa modalità: il motore sceglie di nuovo.
        if (decision === "request_changes") await startWork(workId as string, mode);
      }),
  };
}
