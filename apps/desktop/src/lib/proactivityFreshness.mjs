const STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;

/** Classifies a proactive card without depending on the browser clock. */
export function freshness(card, now) {
  const expiry = card.relevant_until == null ? null : Number(card.relevant_until);
  if (expiry != null && Number.isFinite(expiry) && expiry < now) return "expired";

  const generated = Number(card.generated_at ?? card.created_at);
  if (Number.isFinite(generated) && now - generated > STALE_AFTER_SECONDS) return "stale";
  return "fresh";
}
