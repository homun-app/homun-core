const CLOSED_REASONING_RE = /(?:‹‹REASONING››|<think(?:ing)?>)[\s\S]*?(?:‹‹\/REASONING››|<\/think(?:ing)?>)/gi;
const OPEN_REASONING_RE = /(?:‹‹REASONING››|<think(?:ing)?>)[\s\S]*$/gi;
const STRAY_REASONING_MARKER_RE = /‹+\/?REASONING›+|<\/?think(?:ing)?>/gi;
const LEAKED_TOOLCALL_RE = /<tool_call\b[\s\S]*?(?:<\/tool_call>|$)/gi;
const STRUCTURED_MARKER_RE = /‹‹([A-Z0-9_]+)››[\s\S]*?‹‹\/\1››/g;
const UNCLOSED_STRUCTURED_MARKER_RE = /‹‹[A-Z0-9_]+››[\s\S]*$/g;

export function visibleAssistantText(text = "") {
  return String(text)
    .replace(CLOSED_REASONING_RE, "")
    .replace(OPEN_REASONING_RE, "")
    .replace(LEAKED_TOOLCALL_RE, "")
    .replace(STRUCTURED_MARKER_RE, "")
    .replace(UNCLOSED_STRUCTURED_MARKER_RE, "")
    .replace(STRAY_REASONING_MARKER_RE, "")
    .trim();
}
