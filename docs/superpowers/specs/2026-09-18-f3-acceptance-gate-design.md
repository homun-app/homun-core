# F3 acceptance gate

**Date:** 2026-09-18  
**Status:** accepted (fake CI gate)  
**Live proofs:** manual / `HOMUN_LIVE` — not required to pass CI

## Criteria

1. Three distinct intents (catalogo, ricerca mercato, analisi log) go through
   conversation → work → `post_message` → plan propose without domain/planning
   sector hardcoding.
2. Work objective survives ten sequential `preview_patch` → `apply_patch`
   corrections.
3. FakeProvider may use keyword stubs for deterministic completions; domain and
   planning packages must not.

## Tests

`engine/tests/test_f3_acceptance_gate.py`

## Out of scope here

- Live Ollama NLU quality
- F4 execution / file ingest
