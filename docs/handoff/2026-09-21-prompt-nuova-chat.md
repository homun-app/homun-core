# Prompt di ripresa sviluppo Homun — 21 settembre 2026

> Testo pensato per incollarlo come primo messaggio in una nuova chat con accesso al repository.

---

Riprendi lo sviluppo di Homun nel repository `/Users/fabio/Projects/Homun/homun2` (branch `fabio/production-foundations`, commit più recente `1314db2`). Prima di toccare codice, leggi `AGENTS.md`, `roadmap.md` e `docs/research/2026-09-21-technical-consolidation.md`; la relazione dello stesso giorno sulle decisioni di prodotto è nella conversazione che ho chiuso, i punti salienti sono qui sotto.

## Regole operative (ferree)

- Nessun monolite: moduli piccoli, un solo lavoro ciascuno; non far crescere `ConversationWorkspace` (budget architettura in `tools/architecture-baseline.json`, mai alzarlo).
- Riuso prima di scrivere: se la stessa decisione compare due volte, estrai funzione/componente condiviso (es. `EngineMaterialSelection`, `EngineResultReview`).
- Errori first-class con codici tipizzati (`HomunClientError` / `HomunErrorNotice`); mai fallback silenzioso alla simulazione.
- «Fonte: simulazione | motore» sempre esplicita; nello UI di produzione la parola «motore» non deve apparire.
- Collaboratori AI con nomi propri italiani, mai ruoli come nomi.
- Il profilo reale del motore (`~/Library/Application Support/Homun/engine`, porta 8765) è dell'utente: mai modificarlo direttamente; per i test usa profili temporanei con `HOMUN_DATA_DIR` e porte dedicate.
- Non riscrivere la storia Git pubblicata (Lovable collegato).

## Come lavoro io (importante)

**Verifica sempre come utente, non solo a livello di codice.** Apri l'app nel browser e percorri il flusso reale prima di dichiararlo risolto: questa è stata la mia critica principale e il metodo che mi aspetto. Non fermarti alla prima causa tecnica trovata: se l'utente ha vissuto un percorso rotto, ripercorri quel percorso identico.

## Ambiente

- App: `http://127.0.0.1:4183` (serve `apps/web/dist`; dopo ogni build serve hard reload).
- Motore reale: porta 8765 (`engine/.venv/bin/python -m homun serve --host 127.0.0.1 --port 8765 --dev-insecure`). Se cambio codice motore, va riavviato — verifica sempre con `ps` quando l'utente «non vede differenze».
- Modelli: Ollama su 11434, `glm-5.3-flash:cloud` (thinking: JSON con prosa attorno; il parser tollerante in `engine/src/homun/models/intake.py` lo gestisce).
- Cartella di test materiali: `~/Projects/Homun/materiali-test/` (listino marzo, listino giugno con rincari/rimozioni/aggiunte, PDF condizioni fornitore).
- Verifica: `npm test` (183), `cd engine && .venv/bin/pytest -q` (453), `npx tsc --noEmit`, `npm run build`, test architettura.

## Cosa funziona oggi (verificato end-to-end)

Intake conversazionale con proposta/titolo dal pannello e sidebar; card «Cosa serve ora» dopo accordo di preparazione; cartelle miste (CSV+PDF) con archiviazione integrale e deduplica per contenuto; rimozione materiali; confronto CSV con approvazione, report e review umana («Approva e concludi» / «Richiedi correzioni» con riapertura); letture multiple a catena; revisione supervisionata dell'accordo scrivendo in chat dopo la conferma; cifratura esplicita opt-in con backup cifrato.

## Priorità aperte (in ordine)

1. **Piano multi-fase** — il gap strutturale: un lavoro deve poter dichiarare fasi (raccolta → confronto → sintesi) con più collaboratori e passaggi visibili. Il motore ha già `plan.propose` con passi, dipendenze e assegnatari: l'intake non lo usa. Prima fetta suggerita: quando i file richiesti dalla fase di raccolta ci sono tutti, il lavoro propone da solo il passo eseguibile.
2. **Stabilità della conversazione** — scroll che «salta» durante i caricamenti, attese mute di 30-90s del modello senza stato di avanzamento onesto.
3. **409 su prepare con versione stantia** — oggi errore secco senza recupero guidato.
4. Cifratura: migrazione dei workspace in chiaro, rotazione/perdita chiave, distribuzione `sqlcipher3` (D-CRYPTO-01); backup v1 senza blob.

Parti dalla priorità 1 con una proposta di design prima del codice: disegna il percorso utente (cosa vede, cosa approva, come si chiude) e fammelo validare.
