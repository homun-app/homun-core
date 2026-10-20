"""Primitive condivise del banco di prova «percorso d'oro».

Costanti della UI e del workspace, tempi d'attesa, titoli degli scenari,
l'errore misurato (`GoldenError`) e gli helper di testo: ciò che harness,
client, reporting e scenari usano tutti.
"""
from __future__ import annotations

import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import httpx

GOLDEN_DIR = Path(__file__).resolve().parent
WORKSPACE = "ws_local"
# L'attore della UI web senza intestazioni esplicite (`defaultLocalActor()` in
# engine-domain-client.ts): è lui che compare nel roster e in trascrizione.
UI_ACTOR_ID = "person_fabio"
UI_ACTOR_NAME = "Tu"
# Titolo e obiettivo con cui la UI apre ogni conversazione nuova
# (`createEngineConversationAndWork` in conversation-engine-bridge.ts).
UI_NEW_REQUEST_TITLE = "Nuova richiesta"
UI_NEW_REQUEST_OBJECTIVE = "Obiettivo da concordare"
# Il lavoro interno dei turni di chat con agente (chat_agent.CHAT_WORK_TITLE).
CHAT_WORK_TITLE = "Chat agente"

# Tempi massimi di attesa in secondi: con modelli veri il percorso è lento
# e la suite misura, non corre.
ENGINE_BOOT_TIMEOUT = 40
CHAT_REPLY_TIMEOUT = 300
RECOVERY_WINDOW_TIMEOUT = 180  # A3: finestra di sblocco dopo l'errore provocato
WORK_RUN_TIMEOUT = 600  # esecuzione di un lavoro (sintesi o run agente)
ROUTINE_TICK_TIMEOUT = 150  # D2: prima occorrenza di una routine al minuto
POLL_INTERVAL = 3.0

HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=320.0, write=60.0, pool=360.0)

# Titoli degli scenari come appaiono nel rapporto. Le chiavi sono i prefissi
# dei passi registrati («A1», «B2.conferma» → «B2»).
SCENARIOS: dict[str, str] = {
    "M0": "Connessione modello verificata (Impostazioni → Modelli)",
    "A1": "Domanda semplice: risposta in chat, nessun lavoro creato",
    "A2": "Tre messaggi di fila accettati, nell'ordine giusto",
    "A3": "Dopo un errore provocato il messaggio successivo è accettato",
    "A4": "La conversazione si ritrova e riprende dopo il riavvio",
    "B1": "Richiesta operativa → proposta di lavoro (intake)",
    "B2": "Conferma → esecuzione → risultato prodotto",
    "B3": "Il risultato contiene i fatti dati (Rossi, 30 novembre, 12.000)",
    "B4": "Correzione motivata → nuova versione del risultato",
    "B5": "Il lavoro sta in Compiti, il risultato approvato in Documenti",
    "B6": "Richiesta di lavoro come messaggio successivo: accettata, proposta o chiarimento",
    "B7": "Lavoro eseguito con una connessione creata dall'utente con un nome suo",
    "C1": "Progetto con 2 file caricati (.md e .pdf) leggibili",
    "C2": "Ricerca nei materiali: il risultato cita i contenuti veri dei file",
    "C3": "Riassunto di un file: il risultato ne presenta i punti chiave",
    "D1": "Routine creata con la pianificazione giusta (lunedì alle 9)",
    "D2": "Esecuzione forzata della routine → lavoro ricorrente prodotto",
    "D3": "La routine sopravvive al riavvio del motore ed è ancora attiva",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def redact(text: Any) -> str:
    """Rende sicuro per il rapporto un testo: via token di sessione e chiavi."""
    raw = str(text)
    for name in ("HOMUN_GOLDEN_CLOUD_API_KEY", "HOMUN_SESSION_TOKEN"):
        value = os.environ.get(name)
        if value:
            raw = raw.replace(value, "«rimosso»")
    return raw


def run_count() -> int:
    """Quante volte gira ogni scenario (HOMUN_GOLDEN_RUNS, predefinito 3)."""
    raw = os.environ.get("HOMUN_GOLDEN_RUNS", "3").strip() or "3"
    try:
        count = int(raw)
    except ValueError:
        raise SystemExit(f"HOMUN_GOLDEN_RUNS non è un numero intero: {raw!r}")
    if count < 1:
        raise SystemExit(f"HOMUN_GOLDEN_RUNS deve essere >= 1: {count}")
    return count


def run_indices() -> list[int]:
    return list(range(1, run_count() + 1))


def excerpt_of(text: Any, limit: int = 400) -> str:
    raw = redact(text).replace("\n", " ⏎ ")
    return raw[:limit] + ("…" if len(raw) > limit else "")


def describe(error: GoldenError | None) -> str:
    """Rappresentazione compatta di un errore golden per le asserzioni."""
    return f"{error.code}: {error.reason}" if error else "nessun errore"


def ensure_accepted(error: GoldenError | None, what: str) -> None:
    """Un POST rifiutato fa fallire il passo con il `code` e il `reason` del motore."""
    if error is not None:
        raise GoldenError(error.code, f"{what}: {error.reason}", error.excerpt)


def normalize_for_match(text: str) -> str:
    """Versione normalizzata per controlli robusti sui fatti (12.000 → 12000)."""
    return re.sub(r"[.\s\u00a0,]", "", text.lower())


class GoldenError(Exception):
    """Fallimento misurato di un passo: codice, motivo ed estratto."""

    def __init__(self, code: str, reason: str, excerpt: str = ""):
        super().__init__(f"{code}: {reason}")
        self.code = code
        self.reason = reason
        self.excerpt = excerpt


def wait_until(
    predicate: Callable[[], Any], timeout: float, what: str, interval: float = POLL_INTERVAL
) -> Any:
    """Attende che predicate() restituisca verità; solleva GoldenError a timeout."""
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval)
    raise GoldenError("timeout", f"{what} non riuscito entro {timeout:g}s (ultimo stato: {last!r})")
