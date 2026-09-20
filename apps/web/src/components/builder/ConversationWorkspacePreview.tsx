/**
 * Modal preview for a simulated work result document.
 */

import { Download, X } from "lucide-react";
import type { RefObject } from "react";
import type { ConversationScenario } from "./conversation-scenarios";
import type { Work } from "./conversation-types";

type Props = {
  work: Work;
  scenario: ConversationScenario;
  modalRef: RefObject<HTMLDialogElement | null>;
  onClose: () => void;
  onDownload: () => void;
};

export function ConversationWorkspacePreview({
  work,
  scenario,
  modalRef,
  onClose,
  onDownload,
}: Props) {
  return (
    <dialog
      ref={modalRef}
      className="cw-overlay"
      aria-label="Anteprima risultato"
      onCancel={onClose}
      onClick={onClose}
    >
      <section
        aria-label="Anteprima risultato"
        className="cw-preview"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <span>
            Risultato · {scenario.agent} · v{work.revision}
          </span>
          <div>
            <button className="cw-icon" aria-label="Scarica documento" onClick={onDownload}>
              <Download size={18} />
            </button>
            <button className="cw-icon" aria-label="Chiudi anteprima" onClick={onClose}>
              <X size={19} />
            </button>
          </div>
        </header>
        <div className="cw-preview-body">
          <span className="cw-overline">BOZZA DIMOSTRATIVA</span>
          {scenario.body
            .split("\n")
            .filter(Boolean)
            .map((p, i) =>
              p.startsWith("# ") ? (
                <h1 key={i}>{p.slice(2)}</h1>
              ) : p.startsWith("## ") ? (
                <h3 key={i}>{p.slice(3)}</h3>
              ) : (
                <p key={i}>{p}</p>
              ),
            )}
          {work.feedback && (
            <section className="cw-feedback">
              <h3>Indicazioni di revisione</h3>
              <p>{work.feedback}</p>
              <small>Annotate nella demo; contenuto non riscritto automaticamente.</small>
            </section>
          )}
        </div>
        <footer>
          <button className="cw-secondary" onClick={onClose}>
            Torna alla conversazione
          </button>
        </footer>
      </section>
    </dialog>
  );
}
