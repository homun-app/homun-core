#!/usr/bin/env python3
"""Detect residual Italian strings in source code.

Why function words: Italian and English share a huge vocabulary (information,
format, error...). What does NOT overlap are grammatical words — articles
(il/lo/gli), articulated prepositions (della/negli/sulla), conjunctions
(perche/quindi). They are high-frequency in any Italian sentence and almost
absent in English, so they are a precise, low-false-positive signal.

Scope: the multilingual surface only.
  - Frontend  : apps/desktop/src/**/*.{ts,tsx}  (should use t(), not inline IT)
  - Backend   : crates/**/*.rs                  (prompts/messages must be English)
  - en.json   : flagged if Italian leaks in     (it.json is SKIPPED — it MUST be IT)

Usage:
  python3 scripts/find_italian.py                # report code/string hits, exit 1 if any
  python3 scripts/find_italian.py --comments     # also include comment-only lines
  python3 scripts/find_italian.py --json         # machine-readable
  python3 scripts/find_italian.py --frontend     # only apps/desktop/src
  python3 scripts/find_italian.py --backend      # only crates
"""
from __future__ import annotations
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Italian function words with NO common English collision. Word-boundary matched,
# case-insensitive. Deliberately excludes ambiguous tokens (come, con, ora, in,
# no, a, e, i, o, via, me, date, anno) that appear in English identifiers/text.
ITALIAN_WORDS = [
    # articles / articulated prepositions  (bare elided forms like "all"/"dell"
    # are handled by APOSTROPHE_RE — keep them OUT of here to avoid English "all")
    "il", "lo", "gli", "della", "dello", "delle", "degli", "dei", "dal", "dalla",
    "dallo", "dai", "nella", "nello", "nelle", "negli", "nei", "sulla", "sullo",
    "sugli", "sui", "alla", "allo", "agli",
    # conjunctions / adverbs / pronouns
    "che", "perche", "perché", "gia", "già", "piu", "più", "puo", "può", "senza",
    "quando", "mentre", "anche", "oppure", "invece", "quindi", "perciò", "cioe",
    "cioè", "cosi", "così", "molto", "troppo", "tutto", "tutti", "tutte", "tutta",
    "niente", "nulla", "ogni", "qualsiasi", "nessun", "nessuna", "nessuno",
    "questo", "questa", "questi", "queste", "quello", "quella", "quelli", "quelle",
    "quale", "quali", "essere", "sono", "siamo", "siete", "viene", "vengono",
    "deve", "devono", "puoi", "tuo", "tua", "tuoi", "miei", "mia", "mie",
    "nostro", "nostra", "suo", "sua",
    # high-signal verbs / nouns common in UI & prompts
    "salva", "salvato", "salvati", "annulla", "aggiungi", "elimina", "modifica",
    "chiudi", "apri", "carica", "caricamento", "attiva", "attivo", "attivato",
    "disattiva", "disattivato", "impostazioni", "impostazione", "connetti",
    "connesso", "connessa", "disconnetti", "aggiorna", "seleziona", "scegli",
    "inserisci", "inviato", "inviata", "conferma", "errore", "avviso",
    "attenzione", "riprova", "abilita", "disabilita", "mostra", "nascondi",
    "indietro", "successivo", "precedente", "oggi", "domani", "ieri", "giorno",
    "giorni", "settimana", "mese", "anno", "adesso", "prossimo", "prossima",
    "collega", "collegato", "collegata", "cartella", "chiave", "premi", "leggere",
    "catalogo", "risposta", "azioni", "azione", "dietro", "memoria", "contatti",
    "contatto", "consentiti", "consentito", "fuso", "orari", "orario", "strumenti",
    "strumento", "scheda", "schede", "obiettivo", "obiettivi", "progetto",
    "ricordi", "ricorda", "dispositivo", "pannello", "sviluppatore", "credenziali",
    # curated UI nouns/verbs that carry no function word (low recall otherwise)
    "notifica", "notifiche", "messaggio", "messaggi", "cartelle", "utente",
    "utenti", "assistente", "ricerca", "registro", "allegato", "allegati",
    "immagine", "immagini", "percorso", "riepilogo", "anteprima", "accesso",
    "aggiornamento", "aggiornamenti", "connessione", "connessioni", "risultato",
    "risultati", "dettaglio", "dettagli", "cronologia", "promemoria", "calendario",
    "finestra", "pulsante", "casella", "etichetta", "elenco", "riga", "colonna",
    "sorgente", "destinazione", "scollega", "scarica", "esporta", "importa",
    "condividi", "incolla", "ripristina", "rimuovi", "rigenera", "interrompi",
    "riprendi", "completa", "accedi", "avvia", "riavvia", "spegni", "novità",
    "sicurezza", "riservatezza", "annullato", "completato", "fallito", "riuscito",
    "salvataggio", "eliminazione", "creazione", "modifiche", "impostato",
    "selezionato", "selezionata", "disponibile", "disponibili", "necessario",
    "obbligatorio", "facoltativo", "vuoto", "vuota", "pieno", "aperto", "chiuso",
    # short un-accented nouns/participles common in this codebase (low recall)
    "richiesta", "richieste", "redatto", "redatta", "redatti", "redatte",
    "stato", "inviata", "ricevuto", "ricevuta", "negato", "negata", "vietato",
    "doppioni", "artefatti", "artefatto", "redazione", "redazioni", "citato",
    "citata", "automazione", "automazioni", "generazione", "continuazione",
    "copia", "copiato", "copiata", "rispondi", "risposto", "inoltra",
    "inoltrato", "taglia", "invia", "modifica", "duplica", "sposta",
]

WORD_RE = re.compile(r"(?<![\w'])(" + "|".join(sorted(ITALIAN_WORDS, key=len, reverse=True)) + r")(?![\w'])", re.IGNORECASE)

# Apostrophe-elided Italian: dell'app, l'assistente, un'azione, c'è.
# A letter MUST follow the apostrophe — this excludes single-quoted JS strings
# ('tool', 'add', closed by a non-letter) and English contractions (it's, let's,
# where the apostrophe is followed by s/t/ll/re, handled by the stem allow-list).
APOSTROPHE_RE = re.compile(
    r"(?<![\w'])(dell|nell|sull|all|dall|quell|gliel|un|l|c|d)['’](?=[a-zàèéìòù])",
    re.IGNORECASE,
)

# Italian morphology endings with no English collision (>=4-letter stem). These
# generalize past the curated word list (catch "notificazione", "salvataggio"…).
MORPHOLOGY_RE = re.compile(r"\b[a-z]{3,}(zione|zioni|aggio|aggi|mento|menti| ità)\b", re.IGNORECASE)

# Accented vowels à è ì ò ù are effectively absent from English (é excluded to
# avoid café/résumé). A word containing one is almost certainly Italian.
ACCENT_RE = re.compile(r"[a-z]*[àèìòù][a-z]*", re.IGNORECASE)

# Internal code identifiers that happen to be Italian words but are NOT
# user-facing (typed-union members / state ids wired across components). A line
# is skipped only if its sole Italian signal is one of these — a real Italian
# sentence would trip other words too. Documented so the gate can reach 0.
KNOWN_CODE_IDS = {"catalogo", "attivita", "consentiti", "attive", "memoria"}

EXCLUDE_DIRS = {"node_modules", "target", "dist", "build", ".git", "__pycache__"}
EXCLUDE_DIR_PREFIXES = (".venv",)


def is_excluded_dir(name: str) -> bool:
    return name in EXCLUDE_DIRS or any(name.startswith(p) for p in EXCLUDE_DIR_PREFIXES)


def iter_files(roots, exts, include_tests):
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not is_excluded_dir(d)]
            # test code is internal fixtures, not production strings
            if not include_tests and os.path.basename(dirpath) == "tests":
                continue
            for fn in filenames:
                if not fn.endswith(exts):
                    continue
                # it.json MUST be Italian — never flag it.
                if fn == "it.json":
                    continue
                yield os.path.join(dirpath, fn)


def classify(line: str) -> str:
    s = line.lstrip()
    if s.startswith("//") or s.startswith("/*") or s.startswith("*") or s.startswith("#"):
        return "comment"
    return "code"


def cfg_test_lines(lines):
    """1-based line numbers inside Rust `#[cfg(test)]` blocks (test fixtures are
    internal data, not production strings). Naive brace match — good enough since
    braces balance within a test module even inside format!/json! strings."""
    skip, i, n = set(), 0, len(lines)
    while i < n:
        if "#[cfg(test)]" in lines[i]:
            depth, started, j = 0, False, i
            while j < n:
                depth += lines[j].count("{") - lines[j].count("}")
                skip.add(j + 1)
                if "{" in lines[j]:
                    started = True
                if started and depth <= 0:
                    break
                j += 1
            i = j + 1
        else:
            i += 1
    return skip


def scan(paths, include_comments: bool, include_tests: bool):
    results = {}
    for path in paths:
        try:
            with open(path, encoding="utf-8") as fh:
                lines = fh.readlines()
        except (UnicodeDecodeError, OSError):
            continue
        test_lines = set() if include_tests or not path.endswith(".rs") else cfg_test_lines(lines)
        hits = []
        for i, line in enumerate(lines, 1):
            if i in test_lines:
                continue
            kind = classify(line)
            if kind == "comment" and not include_comments:
                continue
            words = WORD_RE.findall(line)
            words += [m + "'" for m in APOSTROPHE_RE.findall(line)]
            words += ["-" + m for m in MORPHOLOGY_RE.findall(line)]
            words += [m for m in ACCENT_RE.findall(line) if m]
            uniq = {w.lower() for w in words}
            if uniq and uniq <= KNOWN_CODE_IDS:
                continue  # only internal code identifiers on this line — not UI
            if len(words) >= 1:
                hits.append((i, kind, line.rstrip(), sorted(uniq)))
        if hits:
            results[os.path.relpath(path, ROOT)] = hits
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--comments", action="store_true", help="include comment-only lines")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--frontend", action="store_true", help="scan only apps/desktop/src")
    ap.add_argument("--backend", action="store_true", help="scan only crates")
    ap.add_argument("--include-tests", action="store_true",
                    help="include tests/ dirs and #[cfg(test)] blocks (default: skip — fixtures aren't production)")
    args = ap.parse_args()

    front = os.path.join(ROOT, "apps", "desktop", "src")
    back = os.path.join(ROOT, "crates")
    targets = []
    if args.frontend or not args.backend:
        targets += list(iter_files([front], (".ts", ".tsx", ".json"), args.include_tests))
    if args.backend or not args.frontend:
        targets += list(iter_files([back], (".rs",), args.include_tests))

    results = scan(targets, args.comments, args.include_tests)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        total = 0
        for path in sorted(results, key=lambda p: -len(results[p])):
            hits = results[path]
            total += len(hits)
            print(f"\n\033[1m{path}\033[0m  ({len(hits)})")
            for ln, kind, text, words in hits:
                tag = "💬" if kind == "comment" else "  "
                snippet = text.strip()[:110]
                print(f"  {tag} {ln:>5}: {snippet}")
        print(f"\n\033[1mTOTAL: {total} line(s) across {len(results)} file(s)\033[0m")

    sys.exit(1 if results else 0)


if __name__ == "__main__":
    main()
