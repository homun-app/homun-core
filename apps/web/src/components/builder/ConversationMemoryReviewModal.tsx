import { useState } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import {
  reviewEngineMemories,
  type MemoryReviewReport,
} from "@/lib/engine-memory-review-client";
import { CheckCircle2, AlertTriangle, Sparkles, Trash2, X, RefreshCw } from "lucide-react";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  actorId: string;
  projectId?: string | null;
  onMemoriesUpdated?: () => void;
};

export function ConversationMemoryReviewModal({
  isOpen,
  onClose,
  actorId,
  projectId,
  onMemoriesUpdated,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [report, setReport] = useState<MemoryReviewReport | null>(null);
  const [minSim, setMinSim] = useState(0.75);

  if (!isOpen) return null;

  async function handleScan() {
    setLoading(true);
    setError(null);
    try {
      const res = await reviewEngineMemories({
        action: "preview",
        minSimilarity: minSim,
        projectId,
        actorId,
      });
      setReport(res);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }

  async function handlePrune() {
    if (!report || report.duplicate_clusters === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await reviewEngineMemories({
        action: "prune",
        minSimilarity: minSim,
        projectId,
        actorId,
      });
      setReport(res);
      onMemoriesUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-xl border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between border-b border-neutral-100 pb-4 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-amber-500" />
            <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              Revisione e Pulizia Duplicati Memoria
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4">
            <HomunErrorNotice error={error} />
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-neutral-600 dark:text-neutral-400">
          <div className="flex items-center gap-2">
            <span>Soglia similarità:</span>
            <input
              type="range"
              min="0.5"
              max="0.95"
              step="0.05"
              value={minSim}
              onChange={(e) => setMinSim(parseFloat(e.target.value))}
              className="accent-neutral-900 dark:accent-neutral-100"
            />
            <span className="font-mono">{Math.round(minSim * 100)}%</span>
          </div>

          <button
            onClick={handleScan}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Analizza memorie
          </button>
        </div>

        <div className="mt-4 max-h-[50vh] overflow-y-auto space-y-3 pr-1">
          {!report && !loading && (
            <p className="py-8 text-center text-xs text-neutral-500">
              Clicca su &quot;Analizza memorie&quot; per individuare note ridondanti o duplicate tramite confronto semantico.
            </p>
          )}

          {report && report.duplicate_clusters === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-500 mb-2" />
              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                Nessuna nota ridondante rilevata
              </p>
              <p className="text-xs text-neutral-500 mt-1">
                Tutte le {report.total_reviewed} memorie analizzate sono uniche rispetto alla soglia impostata.
              </p>
            </div>
          )}

          {report && report.duplicate_clusters > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span>
                  Trovati <strong>{report.duplicate_clusters}</strong> cluster di duplicati su {report.total_reviewed} note.
                </span>
                {report.status === "pruned" && (
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">
                    Pulite {report.pruned_count} note ridondanti con successo!
                  </span>
                )}
              </div>

              {report.candidates.map((cluster) => (
                <div
                  key={cluster.canonical_id}
                  className="rounded-lg border border-neutral-200 bg-neutral-50/50 p-3 text-xs dark:border-neutral-800 dark:bg-neutral-800/40"
                >
                  <div className="mb-2">
                    <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
                      CANONICA (conservata)
                    </span>
                    <p className="mt-1 font-mono text-neutral-800 dark:text-neutral-200">
                      {cluster.canonical_text}
                    </p>
                  </div>

                  <div className="space-y-1.5 pl-3 border-l-2 border-amber-300 dark:border-amber-700">
                    <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                      RIDONDANTI (sovrapposizione &gt;= {Math.round(cluster.max_similarity * 100)}%)
                    </span>
                    {cluster.redundant_notes.map((r) => (
                      <div key={r.id} className="text-neutral-600 dark:text-neutral-400 flex items-start justify-between gap-2">
                        <span className="italic">{r.text}</span>
                        <span className="font-mono text-[10px] text-neutral-400 shrink-0">
                          {Math.round(r.similarity * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-neutral-100 pt-4 dark:border-neutral-800">
          <span className="text-[11px] text-neutral-400">
            Jaccard token clustering
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Chiudi
            </button>
            {report && report.duplicate_clusters > 0 && report.status !== "pruned" && (
              <button
                onClick={handlePrune}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Elimina {report.candidates.reduce((acc, c) => acc + c.redundant_notes.length, 0)} ridondanti
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
