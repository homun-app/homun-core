// Refresh the local-model catalog the onboarding recommends from.
//
// We scrape ollama.com/library AT BUILD TIME (run by us, never per-user) and ship
// the result as src/assets/models-catalog.json, so the onboarding always has a
// fresh, robust list with zero per-user network fragility. Only FACTS are
// extracted — model slug, parameter sizes, capability flags, pull counts — never
// the prose descriptions. Parsing keys off Ollama's stable `x-test-*` attributes,
// not CSS classes.
//
//   node scripts/refresh-models-catalog.mjs
//
// Falls back to leaving the existing catalog untouched on any failure.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "models-catalog.json");
const SRC = "https://ollama.com/library?c=tools&o=popular";

// Q4_K_M default tags are roughly this many GB per billion params (+ overhead).
const GB_PER_B = 0.62;
// Comfortable RAM floor ≈ weights + KV cache + OS headroom.
const RAM_FACTOR = 1.7;
// Popularity floor so recency can't surface brand-new unproven models as a
// default — we want "established AND current", not "released last week".
const MIN_PULLS = 1_000_000;

function parsePulls(raw) {
  const m = String(raw).trim().match(/^([\d.]+)\s*([MK]?)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  return Math.round(n * (unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1));
}

// "3 weeks ago" / "2 years ago" / "yesterday" -> approximate days, so we can
// decay popularity by age (recent models beat old-but-popular ones).
function parseRecencyDays(text) {
  const t = String(text).toLowerCase().trim();
  if (/yesterday|hour|minute|today/.test(t)) return 1;
  const m = t.match(/(\d+)\s*(day|week|month|year)/);
  if (!m) return 365;
  const n = parseInt(m[1], 10);
  return n * { day: 1, week: 7, month: 30, year: 365 }[m[2]];
}

function tierFor(params) {
  if (params <= 5) return "light";
  if (params <= 9) return "balanced";
  return "powerful";
}

function titleFor(slug, params) {
  const pretty = slug
    .replace(/[-:]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAi\b/g, "AI");
  return `${pretty} ${params}B`;
}

async function main() {
  const res = await fetch(SRC, { headers: { "User-Agent": "Mozilla/5.0 (Homun model catalog refresh)" } });
  if (!res.ok) throw new Error(`ollama.com returned HTTP ${res.status}`);
  const html = await res.text();

  // Split into per-model cards on each library link, then read each card's
  // capability/size/pull-count test markers.
  const chunks = html.split('href="/library/').slice(1);
  const models = [];
  for (const chunk of chunks) {
    const slug = chunk.match(/^([a-z0-9._-]+)"/i)?.[1];
    if (!slug) continue;
    // The chunk already ends at the next library link, i.e. it IS one card — no
    // truncation, or the trailing `x-test-updated` (recency) gets cut off.
    const card = chunk;
    const caps = [...card.matchAll(/x-test-capability[^>]*>([a-z]+)/gi)].map((m) => m[1].toLowerCase());
    if (!caps.includes("tools")) continue; // Homun needs tool-calling
    const sizes = [...card.matchAll(/x-test-size[^>]*>([\d.]+)b/gi)].map((m) => parseFloat(m[1]));
    const pulls = parsePulls(card.match(/x-test-pull-count[^>]*>([\d.]+\s*[MK]?)/i)?.[1] ?? "0");
    if (pulls < MIN_PULLS) continue; // skip the unproven long tail
    const recencyDays = parseRecencyDays(card.match(/x-test-updated[^>]*>([^<]+)</i)?.[1] ?? "");
    // "current best": log-compress popularity (a quality proxy, not a dominator —
    // so one mega-popular old model can't bury the current generation) and decay
    // it exponentially with age (~1yr half-life). Surfaces qwen3.5/gemma4 over
    // llama3.1/qwen2.5.
    const score = Math.log10(Math.max(pulls, 10)) * Math.exp(-recencyDays / 365);
    const vision = caps.includes("vision");
    const thinking = caps.includes("thinking");
    for (const params of sizes) {
      if (!(params >= 0.5 && params <= 16)) continue; // consumer range for onboarding
      const sizeGb = Math.max(0.8, Math.round(params * GB_PER_B * 10) / 10);
      models.push({
        model: `${slug}:${params}b`,
        name: titleFor(slug, params),
        params,
        sizeGb,
        minRamGb: Math.max(4, Math.round((sizeGb * RAM_FACTOR) / 2) * 2),
        tier: tierFor(params),
        tools: true,
        vision,
        thinking,
        pulls,
        recencyDays,
        score,
      });
    }
  }

  // Rank by the recency-decayed score; keep the strongest few per tier so the
  // onboarding stays focused.
  models.sort((a, b) => b.score - a.score);
  const perTier = { light: [], balanced: [], powerful: [] };
  for (const m of models) if (perTier[m.tier].length < 4) perTier[m.tier].push(m);
  const curated = [...perTier.light, ...perTier.balanced, ...perTier.powerful];

  if (curated.length < 3) throw new Error(`scrape yielded too few models (${curated.length})`);

  const catalog = { source: SRC, count: curated.length, models: curated };
  writeFileSync(OUT, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`models-catalog.json: ${curated.length} models (light/balanced/powerful) -> ${OUT}`);
  for (const m of curated) console.log(`  ${m.tier.padEnd(9)} ${m.model.padEnd(20)} ~${m.sizeGb}GB  ${m.pulls.toLocaleString()} pulls${m.vision ? " · vision" : ""}${m.thinking ? " · thinking" : ""}`);
}

main().catch((err) => {
  console.error("refresh-models-catalog failed:", err.message);
  process.exit(1);
});
