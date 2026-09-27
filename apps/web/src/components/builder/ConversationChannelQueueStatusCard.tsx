import { useEffect, useState } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import {
  fetchInboundQueue,
  recoverInboundQueue,
  type InboundQueueItem,
} from "@/lib/engine-channels-queue-client";
import { Layers, RefreshCw, CheckCircle2, Clock, AlertCircle } from "lucide-react";

export function ConversationChannelQueueStatusCard() {
  const [loading, setLoading] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [items, setItems] = useState<InboundQueueItem[]>([]);
  const [recoveredMsg, setRecoveredMsg] = useState<string | null>(null);

  async function loadQueue() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchInboundQueue({ limit: 10 });
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadQueue();
  }, []);

  async function handleRecover() {
    setRecovering(true);
    setError(null);
    setRecoveredMsg(null);
    try {
      const res = await recoverInboundQueue(60.0);
      setRecoveredMsg(`Recuperati ${res.recovered_count} claim pendenti`);
      await loadQueue();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setRecovering(false);
    }
  }

  const pendingCount = items.filter((i) => i.status === "pending" || i.status === "processing").length;
  const failedCount = items.filter((i) => i.status === "failed").length;

  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-50/50 p-4 text-xs dark:border-neutral-800 dark:bg-neutral-900/50">
      <div className="flex items-center justify-between border-b border-neutral-200/60 pb-3 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-neutral-600 dark:text-neutral-400" />
          <h4 className="font-semibold text-neutral-900 dark:text-neutral-100">
            Coda Messaggi Inbound Canali (SQLite Durevole)
          </h4>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadQueue}
            disabled={loading}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-800"
            title="Aggiorna coda"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={handleRecover}
            disabled={recovering}
            className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
          >
            {recovering ? "Recupero..." : "Recupera Claim"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-3">
          <HomunErrorNotice error={error} />
        </div>
      )}

      {recoveredMsg && (
        <div className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">
          {recoveredMsg}
        </div>
      )}

      <div className="mt-3 flex items-center gap-4 text-neutral-600 dark:text-neutral-400">
        <div className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 text-blue-500" />
          <span>In elaborazione / In attesa: <strong>{pendingCount}</strong></span>
        </div>
        <div className="flex items-center gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
          <span>Falliti / Retry: <strong>{failedCount}</strong></span>
        </div>
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          <span>Completati recenti: <strong>{items.filter((i) => i.status === "completed").length}</strong></span>
        </div>
      </div>

      {items.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {items.slice(0, 5).map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between rounded bg-white p-2 font-mono text-[11px] border border-neutral-100 dark:border-neutral-800 dark:bg-neutral-800"
            >
              <div className="flex items-center gap-2">
                <span className="uppercase font-semibold text-neutral-500">{item.platform}</span>
                <span className="text-neutral-400 truncate max-w-[140px]">{item.id}</span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.2 text-[10px] ${
                    item.status === "completed"
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                      : item.status === "failed"
                      ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                      : "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"
                  }`}
                >
                  {item.status}
                </span>
                <span className="text-neutral-400 text-[10px]">{new Date(item.created_at).toLocaleTimeString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
