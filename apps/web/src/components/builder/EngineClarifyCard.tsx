import { useId, useMemo, useRef, useState } from "react";
import "./engine-clarify-card.css";
import {
  formatClarifyAnswers,
  parseClarifyNeed,
  type ParsedChoice,
  type ParsedClarify,
} from "@/lib/engine-clarify-parser";

export type EngineClarifyCardProps = {
  need: string;
  disabled?: boolean;
  onDeliver: (answerText: string, files: File[]) => void;
};

export function EngineClarifyCard({ need, disabled = false, onDeliver }: EngineClarifyCardProps) {
  const parsed = useMemo<ParsedClarify>(() => parseClarifyNeed(need), [need]);
  const baseId = useId();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Initialize pre-selections with recommended choices if available
  const initialSelections = useMemo<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    for (const q of parsed.questions) {
      const recommended = q.choices.find((c) => c.isRecommended);
      if (recommended) {
        initial[q.id] = [recommended.text];
      }
    }
    return initial;
  }, [parsed]);

  const [selections, setSelections] = useState<Record<string, string[]>>(initialSelections);
  const [customText, setCustomText] = useState("");
  const [files, setFiles] = useState<File[]>([]);

  const hasChoiceSelected = Object.values(selections).some((arr) => arr.length > 0);
  const hasTextEntered = customText.trim().length > 0;
  const hasFiles = files.length > 0;
  const canSubmit = !disabled && (hasChoiceSelected || hasTextEntered || hasFiles);

  function toggleChoice(questionId: string, choice: ParsedChoice, isMulti: boolean) {
    if (disabled) return;
    setSelections((prev) => {
      const current = prev[questionId] || [];
      if (!isMulti) {
        return { ...prev, [questionId]: [choice.text] };
      }
      const exists = current.includes(choice.text);
      const next = exists ? current.filter((t) => t !== choice.text) : [...current, choice.text];
      return { ...prev, [questionId]: next };
    });
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    if (event.target.files) {
      const added = Array.from(event.target.files);
      setFiles((curr) => [...curr, ...added]);
    }
  }

  function handleSubmit() {
    if (!canSubmit) return;
    const finalAnswer = formatClarifyAnswers(parsed, selections, customText);
    onDeliver(finalAnswer, files);
  }

  return (
    <div className="cw-clarify-card" role="region" aria-label="Richiesta di chiarimento">
      {parsed.header && <h4 className="cw-clarify-header">{parsed.header}</h4>}

      {parsed.questions.map((q, qIndex) => {
        const selectedForQ = selections[q.id] || [];
        return (
          <fieldset key={q.id} className="cw-clarify-group">
            <legend className="cw-clarify-legend">{q.question}</legend>
            {q.choices.length > 0 && (
              <div className="cw-clarify-choices" role={q.multiSelect ? "group" : "radiogroup"}>
                {q.choices.map((choice, cIndex) => {
                  const inputId = `${baseId}-q${qIndex}-c${cIndex}`;
                  const isSelected = selectedForQ.includes(choice.text);
                  return (
                    <label
                      key={cIndex}
                      htmlFor={inputId}
                      className={`cw-clarify-choice ${isSelected ? "is-selected" : ""}`}
                    >
                      <input
                        id={inputId}
                        type={q.multiSelect ? "checkbox" : "radio"}
                        name={`${baseId}-q${qIndex}`}
                        value={choice.text}
                        checked={isSelected}
                        disabled={disabled}
                        onChange={() => toggleChoice(q.id, choice, q.multiSelect)}
                      />
                      <span className="cw-clarify-choice-label">
                        {choice.text}
                        {choice.isRecommended && (
                          <span className="cs-badge-recommended">Consigliato</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
        );
      })}

      <div className="cw-clarify-custom">
        <textarea
          className="cw-clarify-textarea"
          aria-label="Risposta o note aggiuntive"
          placeholder={
            parsed.isStructured
              ? "Altro o note aggiuntive (opzionale)…"
              : "Scrivi le informazioni o una risposta…"
          }
          value={customText}
          disabled={disabled}
          onChange={(e) => setCustomText(e.target.value)}
        />
      </div>

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error directory attribute
        webkitdirectory="true"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />

      {files.length > 0 && (
        <div className="cw-clarify-files">
          {files.map((f, i) => (
            <p key={i} className="cw-file">
              {f.webkitRelativePath || f.name}
              <button
                type="button"
                aria-label={`Rimuovi allegato ${f.name}`}
                disabled={disabled}
                onClick={() => setFiles(files.filter((_, j) => i !== j))}
              >
                ×
              </button>
            </p>
          ))}
        </div>
      )}

      <div className="cw-clarify-actions">
        <div className="cs-actions">
          <button
            type="button"
            className="cw-secondary"
            disabled={disabled}
            onClick={() => uploadInputRef.current?.click()}
          >
            Allega file
          </button>
          <button
            type="button"
            className="cw-secondary"
            disabled={disabled}
            onClick={() => folderInputRef.current?.click()}
          >
            Allega cartella
          </button>
        </div>
        <button
          type="button"
          className="cw-primary"
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          Invia risposta
        </button>
      </div>
    </div>
  );
}
