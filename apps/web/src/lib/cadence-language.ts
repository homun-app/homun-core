/** Italian cadence phrases → 5-field cron; honest null when unrecognized. */
const WEEKDAYS: Record<string, number> = {
  "lunedì": 1, "martedì": 2, "mercoledì": 3, "giovedì": 4,
  "venerdì": 5, "sabato": 6, "domenica": 0,
};

function parseTime(text: string): { h: number; m: number } | null {
  const match = text.match(/(?:alle?\s+)?(\d{1,2})(?::(\d{2}))?\b/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2] ?? 0);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

/** Returns the cron for a supported cadence phrase, or null (caller keeps the raw input). */
export function cadenceToCron(phrase: string): string | null {
  const text = phrase.trim().toLowerCase();
  const time = parseTime(text);
  if (!time) return null;
  const { h, m } = time;
  if (/(ogni giorno|tutti i giorni|giornaliera)/.test(text)) return `${m} ${h} * * *`;
  if (/(feriale|giorni feriali|lun[-–]ven)/.test(text)) return `${m} ${h} * * 1-5`;
  const weekday = Object.keys(WEEKDAYS).find((day) => text.includes(day));
  if (weekday && /(ogni|tutti|i)\b/.test(text)) return `${m} ${h} * * ${WEEKDAYS[weekday]}`;
  if (/(primo del mese|inizio mese|ogni mese)/.test(text)) return `${m} ${h} 1 * *`;
  if (/(ogni\w* ore|ogni ora)/.test(text)) {
    const hours = text.match(/ogni\s*(\d{1,2})\s*ore?/);
    if (hours) return `0 */${Number(hours[1])} * * *`;
  }
  // A raw 5-field cron from a confident user passes through.
  const fields = text.split(/\s+/);
  if (fields.length === 5 && fields.every((f) => /^[\d*,/-]+$/.test(f))) return text;
  return null;
}
