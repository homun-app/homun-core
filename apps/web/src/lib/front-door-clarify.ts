/**
 * Le domande del chiarimento come la persona deve leggerle: domande, mai JSON.
 *
 * Specchio web della normalizzazione del motore (`AskClarificationArgs`):
 * i modelli piccoli a volte mettono l'elenco in UNA stringa JSON, o
 * concatenano più oggetti JSON, o nascondono il JSON nel testo della domanda.
 * Il motore ormai lo decodifica (e rimanda al modello ciò che non è una
 * domanda); la scheda lo fa di nuovo per non disegnare MAI JSON grezzo,
 * qualunque sia la strada da cui arriva il payload.
 */
import type { FrontDoorClarifyQuestion } from "./front-door-cards.ts";

function looksLikeJson(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith("[") || head.startsWith("{");
}

/**
 * Ogni valore JSON nel testo, in ordine: un elenco, oppure più oggetti (o
 * elenchi) uno dopo l'altro separati solo da spazi. `null` se il testo non è
 * JSON valido da cima a fondo: resta testo.
 */
function jsonValues(text: string): unknown[] | null {
  const values: unknown[] = [];
  let rest = text.trim();
  while (rest) {
    const parsed = parsePrefix(rest);
    if (!parsed) return null;
    values.push(parsed.value);
    rest = rest.slice(parsed.length).trimStart();
  }
  return values;
}

/** Il primo valore JSON in testa a `text` (bilanciando parentesi e stringhe). */
function parsePrefix(text: string): { value: unknown; length: number } | null {
  const open = text[0];
  const close = open === "[" ? "]" : open === "{" ? "}" : null;
  if (!close) return null;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(0, index + 1);
        try {
          return { value: JSON.parse(candidate), length: candidate.length };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function toStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function collect(items: readonly unknown[], out: FrontDoorClarifyQuestion[]): void {
  for (const item of items) {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) continue;
      const decoded = looksLikeJson(text) ? jsonValues(text) : null;
      if (decoded) {
        collect(
          decoded.flatMap((value) => (Array.isArray(value) ? value : [value])),
          out,
        );
        continue;
      }
      out.push({ question: text, choices: [], multi_select: false });
      continue;
    }
    if (Array.isArray(item)) {
      collect(item, out);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question = String(record["question"] ?? "").trim();
    if (!question) continue;
    const decoded = looksLikeJson(question) ? jsonValues(question) : null;
    if (decoded) {
      collect(
        decoded.flatMap((value) => (Array.isArray(value) ? value : [value])),
        out,
      );
      continue;
    }
    out.push({
      question,
      choices: toStrings(record["choices"]),
      multi_select: Boolean(record["multi_select"]),
    });
  }
}

/** Domande pronte da disegnare: JSON decodificato, testo piano com'è. */
export function normalizeClarifyQuestions(
  questions: readonly unknown[],
): FrontDoorClarifyQuestion[] {
  const out: FrontDoorClarifyQuestion[] = [];
  collect(questions, out);
  return out;
}
