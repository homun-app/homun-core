import { useEffect, useState } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import {
  fetchCatalogPacks,
  installCatalogPack,
  uninstallCatalogPack,
  type SkillPack,
} from "@/lib/engine-catalog-client";
import { Package, Download, Trash2, CheckCircle2, RefreshCw, Sparkles } from "lucide-react";

type Props = {
  onPackInstalled?: () => void;
};

export function ConversationSkillPacksSection({ onPackInstalled }: Props) {
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [packs, setPacks] = useState<SkillPack[]>([]);

  async function loadPacks() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCatalogPacks();
      setPacks(res);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPacks();
  }, []);

  async function handleInstall(packId: string) {
    setActionId(packId);
    setError(null);
    try {
      await installCatalogPack(packId);
      await loadPacks();
      onPackInstalled?.();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setActionId(null);
    }
  }

  async function handleUninstall(packId: string) {
    setActionId(packId);
    setError(null);
    try {
      await uninstallCatalogPack(packId);
      await loadPacks();
      onPackInstalled?.();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setActionId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-neutral-200 pb-3 dark:border-neutral-800">
        <div>
          <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
            <Package className="h-4 w-4 text-neutral-600 dark:text-neutral-400" />
            Pacchetti Skill Certificati (Packs)
          </h4>
          <p className="text-xs text-neutral-500">
            Installa insiemi pronti di skill operative con script e guide per il tuo agente.
          </p>
        </div>
        <button
          onClick={loadPacks}
          disabled={loading}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
          title="Aggiorna catalogo"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <HomunErrorNotice error={error} />
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {packs.map((pack) => {
          const isBusy = actionId === pack.id;
          return (
            <div
              key={pack.id}
              className="flex flex-col justify-between rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-neutral-900 dark:text-neutral-100 text-sm">
                      {pack.name}
                    </span>
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-mono text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      v{pack.version}
                    </span>
                  </div>
                  {pack.installed && (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      Installato
                    </span>
                  )}
                </div>

                <p className="mt-1.5 text-xs text-neutral-600 dark:text-neutral-400">
                  {pack.description}
                </p>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {pack.skills.map((skill) => (
                    <span
                      key={skill}
                      className="rounded border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-mono text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-neutral-100 pt-3 dark:border-neutral-800">
                <span className="text-[10px] text-neutral-400 font-mono">
                  {pack.skills.length} skill incluse
                </span>
                {pack.installed ? (
                  <button
                    onClick={() => handleUninstall(pack.id)}
                    disabled={isBusy}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:hover:bg-red-950"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Rimuovi
                  </button>
                ) : (
                  <button
                    onClick={() => handleInstall(pack.id)}
                    disabled={isBusy}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Installa
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
