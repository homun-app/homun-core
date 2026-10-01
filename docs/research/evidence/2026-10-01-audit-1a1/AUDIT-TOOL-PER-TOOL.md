# Audit 1:1 — tool per tool, implementazione reale (2026-10-01)

## Priorità di porting (dal dato, non dall'ipotesi)

1. **Continuità conversazione** — il lavoro chat deve vedere la storia della conversazione
2. **ddgs in subprocess con timeout** — hardening del percorso search
3. **FTS/ricerca semantica** per session_search e memory_recall
4. **Riga data/ora** nel prompt (una riga, effetto immediato)
5. **Retry in-turn** con backoff nel transport

## Tabella delle differenze che contano

| Tool | Hermes | Homun | Differenza |
|---|---|---|---|
| Continuità | Sessione persistente: turno N vede turni 1..N-1 | Lavoro nuovo per messaggio: turno N vede solo messaggio N | IL GAP #1 |
| web_search | ddgs subprocess 30s cap | ddgs in-process senza timeout, fallback UA "Homun" | Homun può bloccarsi |
| web_extract | API vendor (rendering, PDF) | stdlib http (testo grezzo, no PDF) | Bot-walled falliscono |
| memoria | MEMORY.md iniettato sempre | Solo persona iniettata; progetto via substring tool | Hermes ricorda sempre |
| session_search | FTS5/BM25 ranking | Scan lineare substring | Recall qualità |
| prompt sistema | 3 tier + data/ora + platform | Flat + corpus Hermes | Manca data (risposte stantie) |
| chiamata modello | Retry ×3 in-turn + backoff | Un POST, recovery durabile | Hermes auto-ripara nel turno |
