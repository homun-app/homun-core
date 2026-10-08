/** Parse engine clarification requests into structured questions and choices. */

export type ParsedChoice = {
  text: string;
  raw: string;
  isRecommended: boolean;
};

export type ParsedQuestion = {
  id: string;
  question: string;
  choices: ParsedChoice[];
  multiSelect: boolean;
};

export type ParsedClarify = {
  header?: string;
  questions: ParsedQuestion[];
  isStructured: boolean;
};

function parseSingleChoice(rawChoice: string): ParsedChoice {
  const isRecommended =
    /\((?:consigliato|recommended)\)/i.test(rawChoice) ||
    /\[(?:consigliato|recommended)\]/i.test(rawChoice);
  const clean = rawChoice
    .replace(/\s*\((?:consigliato|recommended)\)\s*/gi, "")
    .replace(/\s*\[(?:consigliato|recommended)\]\s*/gi, "")
    .trim();
  return {
    text: clean || rawChoice,
    raw: rawChoice,
    isRecommended,
  };
}

export function parseClarifyNeed(need: string): ParsedClarify {
  const trimmed = need.trim();
  if (!trimmed) {
    return { questions: [], isStructured: false };
  }

  // 1. Try parsing JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const questions: ParsedQuestion[] = parsed.map((item, idx) => ({
          id: String(item.qid || item.id || `q_${idx + 1}`),
          question: item.question || item.prompt || `Domanda ${idx + 1}`,
          choices: Array.isArray(item.choices)
            ? item.choices.map((c: string) => parseSingleChoice(String(c)))
            : [],
          multiSelect: Boolean(item.multi_select || item.multiSelect),
        }));
        return { questions, isStructured: true };
      }

      if (typeof parsed === "object" && parsed !== null) {
        if (Array.isArray(parsed.questions)) {
          const questions: ParsedQuestion[] = parsed.questions.map((item: any, idx: number) => ({
            id: String(item.qid || item.id || `q_${idx + 1}`),
            question: item.question || item.prompt || `Domanda ${idx + 1}`,
            choices: Array.isArray(item.choices)
              ? item.choices.map((c: string) => parseSingleChoice(String(c)))
              : [],
            multiSelect: Boolean(item.multi_select || item.multiSelect),
          }));
          return {
            header: parsed.header || parsed.title,
            questions,
            isStructured: true,
          };
        }

        if (parsed.question) {
          const choices: ParsedChoice[] = Array.isArray(parsed.choices)
            ? parsed.choices.map((c: string) => parseSingleChoice(String(c)))
            : [];
          return {
            questions: [
              {
                id: "q_1",
                question: String(parsed.question),
                choices,
                multiSelect: Boolean(parsed.multi_select || parsed.multiSelect),
              },
            ],
            isStructured: true,
          };
        }
      }
    } catch {
      // Fall through to text parsing
    }
  }

  // 2. Parse text with bulleted or numbered choices
  const lines = trimmed.split("\n");
  const choiceLineRegex = /^(?:[-*•]|\d+[.)])\s+(.+)$/;
  const firstChoiceIndex = lines.findIndex((l) => choiceLineRegex.test(l.trim()));

  if (firstChoiceIndex > 0) {
    const questionText = lines.slice(0, firstChoiceIndex).join(" ").trim();
    const rawChoices: string[] = [];
    for (let i = firstChoiceIndex; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const match = line.match(choiceLineRegex);
      if (match && match[1]) {
        rawChoices.push(match[1].trim());
      } else if (rawChoices.length > 0) {
        // Multi-line choice
        rawChoices[rawChoices.length - 1] += " " + line;
      }
    }

    if (rawChoices.length >= 2) {
      return {
        questions: [
          {
            id: "q_1",
            question: questionText || "Scegli un'opzione:",
            choices: rawChoices.map(parseSingleChoice),
            multiSelect: false,
          },
        ],
        isStructured: true,
      };
    }
  }

  // 3. Fallback: plain text question with no choices
  return {
    questions: [
      {
        id: "q_1",
        question: trimmed,
        choices: [],
        multiSelect: false,
      },
    ],
    isStructured: false,
  };
}

/** Formats user's answers into a clear response string for the engine / collaborator. */
export function formatClarifyAnswers(
  clarify: ParsedClarify,
  selections: Record<string, string[]>,
  customText: string,
): string {
  const parts: string[] = [];

  for (const q of clarify.questions) {
    const selected = selections[q.id] || [];
    if (selected.length > 0) {
      if (clarify.questions.length > 1) {
        parts.push(`- **${q.question}**: ${selected.join(", ")}`);
      } else {
        parts.push(selected.join(", "));
      }
    }
  }

  const trimmedText = customText.trim();
  if (trimmedText) {
    if (parts.length > 0) {
      parts.push(`Note aggiuntive: ${trimmedText}`);
    } else {
      parts.push(trimmedText);
    }
  }

  return parts.join("\n\n");
}
