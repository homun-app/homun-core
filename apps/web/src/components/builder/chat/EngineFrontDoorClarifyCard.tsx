/**
 * La scheda del chiarimento chiesto dal turno di ingresso: le domande con le
 * scelte, e la risposta passa dalla chat (porta d'ingresso unica). Semplice di
 * proposito: niente scadenze né bozze locali, il chiarimento del turno non è
 * la richiesta di contributo di un run.
 *
 * Mai JSON grezzo: le domande passano da `normalizeClarifyQuestions` (una
 * stringa JSON o oggetti concatenati diventano domande) e le scelte sono
 * bottoni cliccabili.
 */
import { useMemo } from "react";
import type { FrontDoorClarifyQuestion } from "@/lib/front-door-cards";
import { normalizeClarifyQuestions } from "@/lib/front-door-clarify";
import { HelpCircle } from "lucide-react";
import "../engine-clarify-card.css";

export function EngineFrontDoorClarifyCard({
  questions,
  disabled = false,
  onSendMessage,
}: {
  questions: FrontDoorClarifyQuestion[];
  disabled?: boolean;
  onSendMessage: (text: string) => void;
}) {
  const shown = useMemo(() => normalizeClarifyQuestions(questions), [questions]);
  return (
    <div className="cw-clarify-card" role="region" aria-label="Domande di chiarimento di Homun">
      <div className="flex items-center gap-2 border-b border-neutral-100 pb-2.5 mb-3">
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
        <h4 className="cw-clarify-header m-0">Prima di proporti il lavoro, dimmi:</h4>
      </div>
      {shown.map((question, qIndex) => (
        <fieldset key={qIndex} className="cw-clarify-group">
          <legend className="cw-clarify-legend">{question.question}</legend>
          {question.choices.length > 0 && (
            <div
              className="cw-clarify-choices"
              role={question.multi_select ? "group" : "radiogroup"}
            >
              {question.choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="cw-clarify-choice cw-clarify-choice-btn"
                  disabled={disabled}
                  onClick={() => onSendMessage(choice)}
                >
                  <span className="cw-clarify-choice-label">{choice}</span>
                </button>
              ))}
            </div>
          )}
        </fieldset>
      ))}
      <p className="cw-clarify-hint text-xs text-neutral-500 m-0">
        Scegli una risposta oppure scrivila in chat: ogni messaggio passa dalla stessa porta.
      </p>
    </div>
  );
}
