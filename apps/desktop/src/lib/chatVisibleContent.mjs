const CLOSED_REASONING = /(?:‹‹REASONING››|<think(?:ing)?>)[\s\S]*?(?:‹‹\/REASONING››|<\/think(?:ing)?>)/gi;
const OPEN_REASONING = /(?:‹‹REASONING››|<think(?:ing)?>)[\s\S]*$/gi;
const STRAY_REASONING_MARKER = /‹+\/?REASONING›+|<\/?think(?:ing)?>/gi;

export function visibleMessageText(text = "") {
  return String(text)
    .replace(CLOSED_REASONING, "")
    .replace(OPEN_REASONING, "")
    .replace(STRAY_REASONING_MARKER, "")
    .trim();
}

export function visibleEventParts(parts = []) {
  return Array.isArray(parts)
    ? parts.filter((part) => part?.type !== "reasoning")
    : [];
}
