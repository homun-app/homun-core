/** Cohesive deliverable review: formatted markdown preview, raw toggle, physical file outputs and review actions. */
import { useState, useCallback } from "react";
import type { Work } from "./conversation-types";
import { EngineResultReview } from "./EngineResultReview";
import { EngineWorkOutputs } from "./EngineWorkOutputs";
import { MessageResponse } from "../ai-elements/message";
import "./engine-artifact-review.css";

export function EngineArtifactReview({
  work,
  onChanged,
  variant = "card",
}: {
  work: Work;
  onChanged: () => Promise<void>;
  variant?: "card" | "inline";
}) {
  const artifact = work.engineLatestArtifact;
  const [viewMode, setViewMode] = useState<"formatted" | "raw">("formatted");
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!artifact?.content) return;
    void navigator.clipboard.writeText(artifact.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [artifact?.content]);

  if (!artifact) return null;

  const isCard = variant === "card";
  const containerClass = isCard ? "cw-artifact-review-card" : "cw-artifact-review-inline";

  return (
    <section className={containerClass} aria-label="Risultato da verificare">
      <div className="cw-intake-eyebrow">RISULTATO DA VERIFICARE</div>

      <div className="cw-artifact-header">
        {isCard ? <h3>{artifact.title}</h3> : <h4>{artifact.title}</h4>}

        <div className="cw-artifact-toolbar" role="toolbar" aria-label="Opzioni visualizzazione">
          <button
            type="button"
            className={viewMode === "formatted" ? "is-active" : ""}
            onClick={() => setViewMode("formatted")}
            title="Visualizza anteprima formattata (Markdown)"
          >
            Anteprima
          </button>
          <button
            type="button"
            className={viewMode === "raw" ? "is-active" : ""}
            onClick={() => setViewMode("raw")}
            title="Visualizza testo grezzo"
          >
            Grezzo
          </button>
          <button
            type="button"
            onClick={handleCopy}
            title="Copia il testo negli appunti"
          >
            {copied ? "Copiato!" : "Copia"}
          </button>
        </div>
      </div>

      <div className="cw-artifact-content">
        {viewMode === "formatted" ? (
          <div className="cw-artifact-markdown">
            <MessageResponse>{artifact.content}</MessageResponse>
          </div>
        ) : (
          <pre className="cw-artifact-raw">{artifact.content}</pre>
        )}
      </div>

      {work.id && (
        <div className="cw-artifact-outputs-section">
          <EngineWorkOutputs workId={work.id} />
        </div>
      )}

      <EngineResultReview work={work} artifactId={artifact.id} onChanged={onChanged} />
    </section>
  );
}
