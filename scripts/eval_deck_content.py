#!/usr/bin/env python3
"""Cross-model eval for the deck-content slot (ADR 0016).

Hits the LOCAL Ollama OpenAI-compat endpoint with the SAME schema + system prompt
that `make_deck` / `generate_deck_content` use, N times, and checks the model
ALWAYS returns schema-valid deck JSON. This is the repeatable guardrail: it must
pass on a weak/local model (Gemma/7B), not only on a frontier one. Degraded
*content* is fine; a missing/invalid structure is a design failure.

Usage:
  python3 scripts/eval_deck_content.py [model] [runs]
  python3 scripts/eval_deck_content.py gemma4:31b-cloud 5

No API key needed for the local daemon (127.0.0.1:11434); :cloud models are
routed by the local Ollama after `ollama signin`.
"""
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:11434/v1/chat/completions"

# Mirror of deck_content_schema() in main.rs — keep in sync.
DECK_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["title", "subtitle", "slides"],
    "properties": {
        "title": {"type": "string"},
        "subtitle": {"type": "string"},
        "slides": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["layout", "title", "bullets", "notes", "want_image"],
                "properties": {
                    "layout": {"type": "string", "enum": ["cover", "section", "bullets", "closing"]},
                    "title": {"type": "string"},
                    "bullets": {"type": "array", "items": {"type": "string"}},
                    "notes": {"type": "string"},
                    "want_image": {"type": "boolean"},
                },
            },
        },
    },
}

SLIDES = 6
SYSTEM = (
    "You are a senior presentation designer. Output ONLY JSON matching the schema. "
    f"Design a tight, on-brand deck of about {SLIDES} slides in it. Rules: the FIRST slide layout "
    'must be "cover" and the LAST "closing"; use "section" only as an occasional divider; every '
    'other slide is "bullets". Headline titles of at most 6 words. At most 4 bullets per slide, '
    "numbers over adjectives, one idea per slide. Write speaker `notes` for the substantive slides. "
    "Set want_image=true on the cover and on AT MOST two of the most visual slides (false on the rest). "
    "Brand: organization «Homun», accent colour #157A6E. Do NOT output colours, fonts, logos or file "
    "names — textual content only."
)
BRIEF = (
    "Crea una presentazione su Homun: assistente personale local-first. "
    "1) Cover; 2) Perché Homun (privacy/local-first, automazioni, deliverable); 3) Chiusura con call to action."
)


def post(model, use_schema):
    rf = (
        {"type": "json_schema", "json_schema": {"name": "deck", "strict": True, "schema": DECK_SCHEMA}}
        if use_schema
        else {"type": "json_object"}
    )
    body = json.dumps(
        {
            "model": model,
            "temperature": 0.4,
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": BRIEF}],
            "response_format": rf,
        }
    ).encode()
    req = urllib.request.Request(BASE, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            payload = json.load(r)
        content = payload["choices"][0]["message"]["content"].strip()
        return 200, content
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]
    except Exception as e:  # noqa: BLE001
        return -1, str(e)


def extract_deck(d):
    """Mirror of extract_deck_object() in main.rs: unwrap a single wrapper key
    ({"presentation": {...}}) since cloud models accept but don't enforce the schema."""
    def has(o):
        return isinstance(o, dict) and isinstance(o.get("slides"), list) and o["slides"]
    if has(d):
        return d
    if isinstance(d, dict):
        for v in d.values():
            if has(v):
                return v
    return None


def validate(content):
    """Return (ok, reason). Mirrors what make_deck relies on (tolerant extraction)."""
    c = content.strip()
    for fence in ("```json", "```"):
        if c.startswith(fence):
            c = c[len(fence):]
    c = c.strip().rstrip("`").strip()
    try:
        d = json.loads(c)
    except Exception as e:  # noqa: BLE001
        return False, f"not JSON: {e}"
    deck = extract_deck(d)
    if deck is None:
        return False, "no slides (even after unwrap)"
    s = deck["slides"]
    # Renderability floor (what make_deck/deck_render actually need): every slide
    # has a valid layout + a non-empty title. bullets/notes/want_image are optional.
    for i, sl in enumerate(s):
        if not isinstance(sl, dict):
            return False, f"slide {i} not an object"
        if sl.get("layout") not in ("cover", "section", "bullets", "closing", "image_left", "image_right"):
            return False, f"slide {i} bad/missing layout {sl.get('layout')!r}"
        if not isinstance(sl.get("title"), str) or not sl["title"].strip():
            return False, f"slide {i} missing title"
    # Soft quality signals (informational, not failures).
    notes = []
    if s[0].get("layout") != "cover":
        notes.append("no cover-first")
    if s[-1].get("layout") != "closing":
        notes.append("no closing-last")
    tail = f" ({'; '.join(notes)})" if notes else ""
    return True, f"{len(s)} slides ok{tail}"


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else "gemma4:31b-cloud"
    runs = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    print(f"== deck-content eval :: model={model} :: runs={runs} :: {BASE}")
    passed = 0
    schema_accepted = None
    for i in range(1, runs + 1):
        t0 = time.time()
        code, content = post(model, use_schema=True)
        used = "json_schema"
        if code == 400:
            schema_accepted = False
            code, content = post(model, use_schema=False)
            used = "json_object(fallback)"
        elif code == 200 and schema_accepted is None:
            schema_accepted = True
        dt = time.time() - t0
        if code != 200:
            print(f"  run {i}: HTTP {code} ({used}, {dt:.1f}s) FAIL :: {content[:120]}")
            continue
        ok, reason = validate(content)
        passed += ok
        print(f"  run {i}: 200 ({used}, {dt:.1f}s) {'PASS' if ok else 'FAIL'} :: {reason}")
    print(f"== result: {passed}/{runs} schema-valid :: json_schema accepted by endpoint: {schema_accepted}")
    sys.exit(0 if passed == runs else 1)


if __name__ == "__main__":
    main()
