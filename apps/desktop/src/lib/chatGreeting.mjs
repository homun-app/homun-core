const CATALOG_SIZE = 4;

export function greetingPeriod(hour) {
  const normalized = Number.isFinite(hour) ? ((Math.trunc(hour) % 24) + 24) % 24 : 12;
  if (normalized >= 5 && normalized < 12) return "morning";
  if (normalized >= 12 && normalized < 18) return "afternoon";
  return "evening";
}

export function selectGreetingKey({
  hour,
  hasName = false,
  hasProject = false,
  returning = false,
  seed = "homun",
}) {
  const period = greetingPeriod(hour);
  const context = hasProject ? "project" : returning ? "returning" : hasName ? "named" : "anonymous";
  const index = stableHash(`${period}:${context}:${seed}`) % CATALOG_SIZE;
  return `chat.greetings.${period}.${context}.${index}`;
}

function stableHash(value) {
  let hash = 2_166_136_261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}
