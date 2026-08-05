import { Check, CheckSquare, Square } from "lucide-react";
import { useState } from "react";

/** A single/multi-choice question the model asks the user. */
export interface ChoicePrompt {
  question: string;
  multi: boolean;
  options: string[];
  /** Set for proactivity-origin questions: answering captures the pick as memory. */
  purpose?: string;
}

/** Single/multi-choice question card. Single: each option is a button that sends the
 * answer on click. Multi: toggle chips plus a Confirm button that sends the joined
 * selection. The answer becomes the next user message. */
export function ChoicesCard({
  prompt,
  onChoose,
}: {
  prompt: ChoicePrompt;
  onChoose: (answer: string, purpose?: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  if (sent) {
    return (
      <div className="choices-card done">
        <Check size={14} />
        <span>{picked.join(", ")}</span>
      </div>
    );
  }
  const toggle = (option: string) =>
    setPicked((cur) =>
      cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option],
    );
  const send = (answer: string[]) => {
    if (answer.length === 0) return;
    setPicked(answer);
    setSent(true);
    onChoose(answer.join(", "), prompt.purpose);
  };
  return (
    <div className="choices-card">
      {prompt.question && <p className="choices-question">{prompt.question}</p>}
      <div className="choices-options">
        {prompt.options.map((option) => {
          const active = picked.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={`choices-option ${active ? "active" : ""}`}
              onClick={() => (prompt.multi ? toggle(option) : send([option]))}
            >
              {prompt.multi &&
                (active ? <CheckSquare size={15} /> : <Square size={15} />)}
              <span>{option}</span>
            </button>
          );
        })}
      </div>
      {prompt.multi && (
        <button
          type="button"
          className="choices-confirm"
          disabled={picked.length === 0}
          onClick={() => send(picked)}
        >
          Confirm{picked.length > 0 ? ` (${picked.length})` : ""}
        </button>
      )}
    </div>
  );
}
