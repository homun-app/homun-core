#!/usr/bin/env python3
"""Cross-model eval suite (WS8) — the guardrail for caposaldo #2.

Runs the KEY structured-output flows against the configured LOCAL model and asserts
they complete schema-valid. Orchestration must work on the local tier (Gemma/7B):
degraded *content* is fine, a broken/empty/off-schema structure is a design failure.

Pure Python; hits the local Ollama OpenAI-compat endpoint (127.0.0.1:11434/v1) — no
gateway needed. :cloud models are routed by the local daemon after `ollama signin`.

Usage:
  python3 scripts/eval_suite.py [model] [runs]
  python3 scripts/eval_suite.py gemma4:latest 3

Exit 0 only if every check passes all runs. Wire into pre-release later (WS8.3).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("HOMUN_EVAL_BASE", "http://127.0.0.1:11434/v1/chat/completions")


def post(model, system, user, schema):
    """One structured call; tries strict json_schema, degrades to json_object on 400
    (mirrors the gateway floor). Returns (http_code, content_str)."""
    def body(use_schema):
        rf = (
            {"type": "json_schema", "json_schema": {"name": "out", "strict": True, "schema": schema}}
            if use_schema
            else {"type": "json_object"}
        )
        return json.dumps(
            {
                "model": model,
                "temperature": 0.2,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "response_format": rf,
            }
        ).encode()

    for i, use_schema in enumerate((True, False)):
        req = urllib.request.Request(BASE, data=body(use_schema), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=240) as r:
                payload = json.load(r)
            return 200, payload["choices"][0]["message"]["content"].strip()
        except urllib.error.HTTPError as e:
            if e.code == 400 and i == 0:
                continue
            return e.code, e.read().decode()[:200]
        except Exception as e:  # noqa: BLE001
            return -1, str(e)
    return -1, "no response"


def parse_json(content):
    c = content.strip()
    for fence in ("```json", "```"):
        if c.startswith(fence):
            c = c[len(fence):]
    c = c.strip().rstrip("`").strip()
    return json.loads(c)


def find_with(d, key):
    """Tolerant unwrap: object that has `key`, at top level or one level down
    (cloud models accept but don't enforce schema → may wrap)."""
    if isinstance(d, dict) and key in d:
        return d
    if isinstance(d, dict):
        for v in d.values():
            if isinstance(v, dict) and key in v:
                return v
    return None


# ---- checks: (name, schema, system, user, validate(parsed)->(ok,reason)) ----

DECK_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["title", "subtitle", "slides"],
    "properties": {
        "title": {"type": "string"}, "subtitle": {"type": "string"},
        "slides": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["layout", "title", "bullets", "notes", "want_image"],
            "properties": {
                "layout": {"type": "string", "enum": ["cover", "section", "bullets", "closing"]},
                "title": {"type": "string"},
                "bullets": {"type": "array", "items": {"type": "string"}},
                "notes": {"type": "string"}, "want_image": {"type": "boolean"},
            }}},
    },
}


def v_deck(d):
    deck = find_with(d, "slides")
    if not deck or not isinstance(deck.get("slides"), list) or not deck["slides"]:
        return False, "no slides"
    for i, s in enumerate(deck["slides"]):
        if not isinstance(s, dict) or not isinstance(s.get("title"), str) or not s["title"].strip():
            return False, f"slide {i} bad"
    return True, f"{len(deck['slides'])} slides"


DOCUMENT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["title", "document_type", "sections", "formats"],
    "properties": {
        "title": {"type": "string"},
        "document_type": {"type": "string", "enum": ["memo", "report", "proposal", "brief"]},
        "sections": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["heading", "purpose", "bullets"],
            "properties": {
                "heading": {"type": "string"},
                "purpose": {"type": "string"},
                "bullets": {"type": "array", "items": {"type": "string"}},
            }}},
        "formats": {"type": "array", "items": {"type": "string", "enum": ["md", "pdf", "docx"]}},
    },
}


def v_document(d):
    doc = find_with(d, "sections")
    if not doc:
        return False, "no document"
    sections = doc.get("sections")
    if not isinstance(sections, list) or len(sections) < 3:
        return False, "too few sections"
    formats = doc.get("formats")
    if not isinstance(formats, list) or "docx" not in formats:
        return False, "missing docx"
    for i, section in enumerate(sections):
        if not isinstance(section, dict):
            return False, f"section {i} bad"
        if not isinstance(section.get("heading"), str) or not section["heading"].strip():
            return False, f"section {i} no heading"
        bullets = section.get("bullets")
        if not isinstance(bullets, list) or not bullets:
            return False, f"section {i} no bullets"
    return True, f"{len(sections)} sections + {','.join(formats)}"


PLAN_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["steps"],
    "properties": {"steps": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["title", "status", "done_criterion"],
        "properties": {
            "title": {"type": "string"},
            "status": {"type": "string", "enum": ["todo", "doing", "done", "blocked"]},
            "done_criterion": {"type": "string"},
        }}}},
}


def v_plan(d):
    p = find_with(d, "steps")
    if not p or not isinstance(p.get("steps"), list) or not p["steps"]:
        return False, "no steps"
    for i, s in enumerate(p["steps"]):
        if not isinstance(s.get("title"), str) or not s["title"].strip():
            return False, f"step {i} no title"
        if s.get("status") not in ("todo", "doing", "done", "blocked"):
            return False, f"step {i} bad status"
    return True, f"{len(p['steps'])} steps"


DECISION_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["memory_type", "text", "why"],
    "properties": {
        "memory_type": {"type": "string", "enum": ["fact", "preference", "decision", "goal"]},
        "text": {"type": "string"}, "why": {"type": "string"},
    },
}


def v_decision(d):
    o = find_with(d, "text")
    if not o:
        return False, "no object"
    if not isinstance(o.get("text"), str) or not o["text"].strip():
        return False, "empty text"
    if not isinstance(o.get("why"), str) or not o["why"].strip():
        return False, "missing WHY"  # caposaldo #8: a decision must carry its why
    return True, f"{o.get('memory_type')} +why"


OPENLOOP_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["memory_type", "text", "why"],
    "properties": {
        "memory_type": {"type": "string", "enum": ["open_loop"]},
        "text": {"type": "string"}, "why": {"type": "string"},
    },
}


def v_openloop(d):
    o = find_with(d, "text")
    if not o:
        return False, "no object"
    if o.get("memory_type") != "open_loop":
        return False, f"type {o.get('memory_type')}"
    if not isinstance(o.get("text"), str) or not o["text"].strip():
        return False, "empty text"
    if not isinstance(o.get("why"), str) or not o["why"].strip():
        return False, "no why"  # WS5.3: an open loop must carry what remains + why
    return True, "open_loop +why"


CHECKS = [
    ("deck", DECK_SCHEMA,
     "You are a presentation designer. Output ONLY JSON matching the schema, in the language of the brief.",
     "Crea una presentazione di 4 slide su Homun (assistente local-first).", v_deck),
    ("document", DOCUMENT_SCHEMA,
     "You are a senior business writer. Output ONLY JSON matching the schema. The formats array MUST include docx.",
     "Prepara la struttura di un documento professionale su Homun per una PMI italiana: problema, soluzione, "
     "sicurezza local-first e prossimi passi. Deve poter diventare DOCX.",
     v_document),
    ("plan", PLAN_SCHEMA,
     "You are a planner. Output ONLY JSON matching the schema: an ordered list of concrete steps "
     "with a status and a checkable done_criterion.",
     "Pianifica: creare e pubblicare una presentazione on-brand su un prodotto.", v_plan),
    ("decision+why", DECISION_SCHEMA,
     "Extract ONE durable memory from the text as JSON matching the schema. For a decision, "
     "the `why` field MUST capture the reasoning.",
     "Abbiamo scelto JSON invece di SQLite per lo storage del todo CLI perché è nativo in Python, "
     "human-readable e senza dipendenze.", v_decision),
    ("open_loop+why", OPENLOOP_SCHEMA,
     "Extract the OPEN LOOP (unfinished work) from the text as JSON: what REMAINS to do (text) "
     "and WHY it is still open (why).",
     "Abbiamo implementato il render del deck ma manca ancora la gestione delle immagini quando il "
     "modello immagine non è configurato; va completato.", v_openloop),
]


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else "gemma4:latest"
    runs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    print(f"== eval suite :: model={model} :: runs={runs} :: {BASE}", flush=True)
    all_ok = True
    for name, schema, system, user, validate in CHECKS:
        passed = 0
        last = ""
        for _ in range(runs):
            t0 = time.time()
            code, content = post(model, system, user, schema)
            dt = time.time() - t0
            if code != 200:
                last = f"HTTP {code}: {content[:80]}"
                continue
            try:
                ok, reason = validate(parse_json(content))
            except Exception as e:  # noqa: BLE001
                ok, reason = False, f"parse: {e}"
            passed += ok
            last = f"{reason} ({dt:.0f}s)"
        mark = "PASS" if passed == runs else "FAIL"
        if passed != runs:
            all_ok = False
        print(f"  [{mark}] {name:14} {passed}/{runs}  :: {last}", flush=True)
    print(f"== {'ALL GREEN' if all_ok else 'FAILURES'} ==", flush=True)
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
