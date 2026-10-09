/**
 * Actionable first-run checklist when Fonte=motore but no usable model is linked.
 * Never offers simulation fallback.
 */
import { useEffect, useState } from "react";
import { ArrowRight, PlugZap } from "lucide-react";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import { listModelProviders } from "@/lib/engine-models-client";
import { hasUsableModelProvider } from "@/lib/usable-model-provider";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";

type Props = {
  onOpenModels: () => void;
};

export function ConversationFirstRunChecklist({ onOpenModels }: Props) {
  const status = useEngineStatus();
  const engineReady =
    status.dataSource === "engine" &&
    status.connection === "connected" &&
    Boolean(status.capabilities?.features.models);
  const [ready, setReady] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!engineReady) {
      setReady(null);
      return;
    }
    let live = true;
    listModelProviders()
      .then((data) => {
        if (!live) return;
        setReady(hasUsableModelProvider(data.items, data.active_provider_id));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setReady(false);
        setError(cause);
      });
    return () => {
      live = false;
    };
  }, [engineReady, status.connection]);

  if (status.dataSource !== "engine") return null;
  if (status.connection === "checking") return null;
  if (status.connection === "absent") {
    return (
      <div className="cw-first-run" role="status">
        <PlugZap size={16} aria-hidden />
        <div className="cw-first-run__body">
          <strong>Homun non è ancora raggiungibile</strong>
          <p>
            Avvia Homun su questo computer, poi riprova. Restiamo sul percorso motore — niente
            demo simulata.
          </p>
        </div>
      </div>
    );
  }
  if (ready !== false) return null;

  return (
    <div className="cw-first-run" role="status">
      <PlugZap size={16} aria-hidden />
      <div className="cw-first-run__body">
        <strong>Collega un modello per il primo risultato</strong>
        <ol className="cw-first-run__steps">
          <li>Apri Impostazioni → Modelli collegati</li>
          <li>Scegli Ollama locale o un provider cloud</li>
          <li>Torna qui e prova una richiesta breve</li>
        </ol>
        <HomunErrorNotice error={error} />
        <button type="button" className="cw-first-run__cta" onClick={onOpenModels}>
          Collega un modello
          <ArrowRight size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}
