import { useEffect, useId, useMemo, useRef, useState } from "react";
import "./engine-clarify-card.css";
import {
  formatClarifyAnswers,
  parseClarifyNeed,
  type ParsedChoice,
  type ParsedClarify,
} from "@/lib/engine-clarify-parser";
import { Clock, Check } from "lucide-react";

export type EngineClarifyCardProps = {
  need: string;
  disabled?: boolean;
  deadline?: string | null | undefined;
  requestId?: string | undefined;
  initialDraftText?: string | undefined;
  onSaveDraft?: ((draftText: string) => Promise<void>) | undefined;
  onDeliver: (answerText: string, files: File[]) => void;
};

export function EngineClarifyCard({
  need,
  disabled = false,
  deadline,
  requestId,
  initialDraftText,
  onSaveDraft,
  onDeliver,
}: EngineClarifyCardProps) {
  const parsed = useMemo<ParsedClarify>(() => parseClarifyNeed(need), [need]);
  const baseId = useId();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Storage key for local draft persistence
  const storageKey = useMemo(() => {
    return `homun_clarify_draft_${requestId || need.slice(0, 32)}`;
  }, [requestId, need]);

  // Read cached draft if available
  const cachedDraft = useMemo(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return JSON.parse(raw);
    } catch {
      // ignore
    }
    return null;
  }, [storageKey]);

  // Deadline countdown state
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    if (!deadline) {
      setTimeLeft(null);
      setIsExpired(false);
      return;
    }

    function updateTimer() {
      const target = new Date(deadline!).getTime();
      const now = Date.now();
      const diff = target - now;

      if (diff <= 0) {
        setTimeLeft("00:00");
        setIsExpired(true);
      } else {
        const totalSec = Math.floor(diff / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        setTimeLeft(`${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`);
        setIsExpired(false);
      }
    }

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  // Initialize pre-selections with recommended choices or cached selections
  const initialSelections = useMemo<Record<string, string[]>>(() => {
    if (cachedDraft?.selections) return cachedDraft.selections;
    const initial: Record<string, string[]> = {};
    for (const q of parsed.questions) {
      const recommended = q.choices.find((c) => c.isRecommended);
      if (recommended) {
        initial[q.id] = [recommended.text];
      }
    }
    return initial;
  }, [parsed, cachedDraft]);

  const [selections, setSelections] = useState<Record<string, string[]>>(initialSelections);
  const [customText, setCustomText] = useState(cachedDraft?.text || initialDraftText || "");
  const [files, setFiles] = useState<File[]>([]);
  const [draftSaved, setDraftSaved] = useState(false);

  // Debounced auto-save draft
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ selections, text: customText }));
        setDraftSaved(true);
        setTimeout(() => setDraftSaved(false), 2000);
      } catch {
        // ignore storage errors
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [selections, customText, storageKey]);

  const isInteractivityDisabled = disabled || isExpired;
  const hasChoiceSelected = Object.values(selections).some((arr) => arr.length > 0);
  const hasTextEntered = customText.trim().length > 0;
  const hasFiles = files.length > 0;
  const canSubmit = !isInteractivityDisabled && (hasChoiceSelected || hasTextEntered || hasFiles);

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
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    const finalAnswer = formatClarifyAnswers(parsed, selections, customText);
    onDeliver(finalAnswer, files);
  }

  return (
    <div className="cw-clarify-card" role="region" aria-label="Richiesta di chiarimento">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-100 pb-2.5 mb-3">
        {parsed.header ? (
          <h4 className="cw-clarify-header m-0">{parsed.header}</h4>
        ) : (
          <span className="font-semibold text-xs text-neutral-800">Chiarimento richiesto</span>
        )}
        <div className="flex items-center gap-2">
          {draftSaved && (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
              <Check className="h-3 w-3" /> Bozza salvata
            </span>
          )}
          {timeLeft && (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono font-medium ${
                isExpired ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
              }`}
            >
              <Clock className="h-3 w-3" />
              {isExpired ? "Scaduto" : `Scade in ${timeLeft}`}
            </span>
          )}
        </div>
      </div>

      {isExpired && (
        <div className="mb-3 rounded bg-red-50 p-2 text-xs text-red-700 border border-red-200">
          Il tempo per rispondere è scaduto. La richiesta è in fase di completamento o scadenza automatica.
        </div>
      )}

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
