import { useState, useCallback } from "react";
import { Eye, Code2, Copy, Check } from "lucide-react";
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
    const text = artifact.content;
    const markCopied = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    };

    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(markCopied).catch(() => {
        fallbackCopy(text);
        markCopied();
      });
    } else {
      fallbackCopy(text);
      markCopied();
    }

    function fallbackCopy(val: string) {
      try {
        const el = document.createElement("textarea");
        el.value = val;
        el.setAttribute("readonly", "");
        el.style.position = "absolute";
        el.style.left = "-9999px";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      } catch {}
    }
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
            title="Anteprima"
            aria-label="Anteprima"
          >
            <Eye size={14} />
          </button>
          <button
            type="button"
            className={viewMode === "raw" ? "is-active" : ""}
            onClick={() => setViewMode("raw")}
            title="Grezzo"
            aria-label="Grezzo"
          >
            <Code2 size={14} />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className={`cw-artifact-copy-btn ${copied ? "is-copied" : ""}`}
            title={copied ? "Copiato negli appunti!" : "Copia contenuto"}
            aria-label={copied ? "Copiato" : "Copia"}
          >
            {copied ? <Check size={14} className="cw-copied-icon" /> : <Copy size={14} />}
            {copied && <span className="cw-copied-label">Copiato!</span>}
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
