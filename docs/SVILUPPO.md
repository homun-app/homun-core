# Homun — documento unico di sviluppo

> Fonte unica di verità su cosa è fatto, cosa resta e in che ordine.
> Aggiornato il 7 ottobre 2026 con audit voce-per-voce del piano storico
> (`development/2026-09-17-piano-sviluppo.md`) contro il codice reale.
> Ogni voce "fatta" ha evidenza verificabile: modulo, rotta o test citati.

**Numeri di riferimento**: suite engine **1972 test verdi** (226 file),
web 256, typecheck/build/architettura verdi. Parity differenziale con
Hermes rc.35-v0.21.5 del 2026-10-07 (`research/evidence/2026-10-07-parity-rc35/`).

---

## 1. Cosa è fatto (verificato per fase)

### F0 — Decisioni e prove
- ✅ F0.1 inventario riuso vecchio Homun → `research/2026-09-19-hermes-homun-comparison.md`, `2026-09-23-owned-core-verifica.md`
- ✅ F0.2 runtime adottato: Pydantic AI + DBOS (ADR D-RUN-01)
- ✅ F0.3 packaging: app Electron avvia il proprio motore (bundle/venv) con sessione; installer `apps/desktop/dist-installers/Homun-0.2.0-arm64.dmg`
- ⬜ F0.4 prova rete LAN/due reti — mai eseguita (dipende da F5)
- ◐ F0.5 cifratura a riposo: `storage/encryption.py` con SQLCipher, ma D-CRYPTO-01 resta aperta (non dichiarata pronta)

### F1-F2 — Dominio, persistenza, API
✅ Complete (comandi/eventi con actor e versioni, SQLite WAL ottimistica,
API con cursor, backup consistente F2.5 — restore drill riuscito su backup
reale il 2026-10-07).

### F3 — Chat e piano reali
✅ Completa (provider fake+reali, interpretazione, patch versionate,
streaming interrompibile, Mem0 locale).

### F4 — Esecuzione, input e risultati
✅ **Completa** (le caselle stantie del piano sono state verificate):
- F4.3 contributi tipizzati: `application/agent_clarification.py`, `clarify_contracts.py`, intake
- F4.4 artifacts versionati: `routes/work_outputs.py`, `application/work_outputs.py`
- F4.5 review su versione + autonomia (`autonomy_mode` supervised/autonomous con auto-approvazione policy)
- F4.6 pausa/annulla/steer/ripresa: `application/agent_control.py`, visibili in chat e pannello lavori

### F5 — Collaborazione tra applicazioni ◐ **fetta 1 consegnata (2026-10-07)**
Specifiche: `development/2026-10-07-f5-collaborazione-specifica.md`.
- ✅ **Fetta 1** — persone, inviti monouso, sessioni: `Person`/`PersonDevice`
  nel dominio, comandi invite/confirm/revoke/bootstrap, inviti monouso con
  secret validato nel comando, `POST /v1/session/redeem` che apre sessioni
  legate alla persona, registry sessioni con revoca persona/dispositivo,
  middleware multi-persona retrocompatibile col token del desktop, bootstrap
  owner con continuità degli AccessGrant esistenti, pannello Impostazioni →
  Persone (i collaboratori dimostrativi sono stati rimossi).
  Test: `test_identity_f51.py` (6). Restano della fetta: esperienza di
  riscatto guidata lato client (con la fetta 2).
- ✅ **Fetta 2** (2026-10-07) — pairing remoto con prova di possesso:
  `peers/` con chiave Ed25519 del dispositivo (privata mai in rete),
  `/v1/remote/pair` in due passaggi (presentazione con chiave pubblica e
  nonce di sfida → firma: l'invito si consuma solo a firma giusta, un
  impostore non lo brucia), versione protocollo esplicita, sfida breve
  (10 min), token di trasporto legato al dispositivo con revoca immediata,
  client peer `pair_with_host`/`remote_request`, middleware Bearer-persona
  sempre attivo (no-op in session mode, abilita i peer in dev).
  Verificato dal vivo su HTTP reale. Test: `test_remote_pairing_f52.py` (6).
- ✅ **Fetta 3** (2026-10-07) — replica selettiva in lettura per progetto:
  snapshot di bootstrap + feed eventi con cursor (sequence dell'host) su
  `/v1/remote/{events,snapshot}`, perimetro = solo ciò che la policy
  autorizza (revoca del grant interrompe lo stream); lato peer
  `sync_remote_project` con proiezione in tabella separata, marcata
  Fonte: motore remoto. Test: `test_remote_replication_f53.py` (3).
- ✅ **Fetta 4** (2026-10-07) — contributi remoti con outbox onesto:
  `POST /v1/remote/commands` (received ≠ accepted, perimetro comandi
  limitato), outbox peer con stati pending/delivered/conflict — host
  assente = in attesa di consegna, mai salvato; flush ordinato e dedup
  per command_id. Test: `test_remote_outbox_f54.py` (3).
- ✅ **Fetta 6 (core)** (2026-10-07) — delega ai peer: `PeerAssignment`
  con offer/accept/return/revoke; ritorno idempotente per fingerprint
  (stesso risultato riconferma, diverso = conflitto), scadenza valutata
  a ogni tocco, solo l'assegnatario tocca; endpoint remoti
  `/remote/assignments` + accept/return. Test: `test_delegation_f56.py` (3).
- ✅ **Toolkit pilot** (2026-10-07) — `homun peer …` dal terminale: pair
  (con chiave del dispositivo in data dir), status (connessioni + outbox),
  projects, sync, message, assignments/accept/return. Store connessioni in
  `remote-peers.db`; rotte lato peer `/v1/peers/{connections,projections}`
  per la UI futura. **Pilot dimostrato dal vivo su due engine reali**
  (porte diverse, data dir diverse): pair → grant → sync → contributo
  arrivato all'host → delega offerta/accettata/restituita con ricevuta.
  Test: `test_peer_cli_f5.py`.
- ✅ **Onboarding e pannello UI** (2026-10-07) — Impostazioni → Spazi
  remoti: «Entra nello spazio» con host+invito+nome (il motore riscatta
  con la chiave del proprio dispositivo, `POST /v1/peers/connect`),
  elenco connessioni con fingerprint, proiezioni sincronizzate con
  badge Fonte: motore remoto e «Sincronizza ora». Verificato nel browser
  end-to-end: il dev engine è entrato in un terzo engine come peer e il
  progetto condiviso appare nel pannello. Host irraggiungibile = errore
  tipizzato remote_unavailable.
- ◐ **Fetta 5 (E2E)**: NON iniziata — cifratura per oggetto/destinatario e
  transfer con manifest: serve review del protocollo prima (doc
  distribuzione dati §3). Il pilot su VPN non la richiede.
- ⬜ Collegamento delega↔ledger budget (riserva atomica sugli assignment)
  e reconcile dopo timeout: passo successivo della fetta 6.

### F6 — Strumenti e connettori
- ✅ F6.2 web search (ddgs, `tools/search.py`, protezione errori-retry)
- ✅ F6.4 MCP (rotte `mcp.py`+oauth, catalogo connettori, skill builtin versionate `builtin_skills.py`)
- ◐ F6.5 email: trasporto smtp presente negli adattatori canale, non provata end-to-end
- ◐ F6.6 revoca plugin: manager con enable/disable; segnalazione lavori dipendenti da fare
- ⬜ F6.1 ToolGrant separato per strumento (oggi le capability sono per-run)
- ⬜ F6.3 connettore Trello (mai avviato)

### F7 — Automazioni
- ✅ F7.3 scheduler persistente DBOS con misfire policy e deduplica (`application/cron_manager.py`, `cron_contracts.py`, `cron_dispatcher.py`)
- ◐ F7.1 conversazione→metodo: c'è `skill_reflection.py` (lezioni apprese), manca la promozione esplicita a routine
- ◐ F7.2 routine con schema/riepilogo (creatore UI esiste nel pannello lavoro)
- ◐ F7.4 trigger esterni (webhook relay, msgraph); ◐ F7.5 pausa/modifica (rotta pause)
- **Debito noto**: la vista "Automazioni" della sidebar gira ancora su dati simulati — le routine vere sono solo nel pannello lavoro (violazione Fonte: motore, da collegare)

### F8 — Memoria e formazione
- ✅ F8.1 budget di contesto e riassunti con provenienza (`models/context_summary.py`, parity Hermes)
- ✅ F8.3 correzione→lezione→riprova (`application/skill_reflection.py`)
- ◐ F8.2 memorie per ambito con isolamento progetto (memory ports + ledger); promozione decisioni condivise da fare
- ◐ F8.4 invalidazione su revoca; ◐ F8.5 retrieval semantico (Mem0/Qdrant locali, backends esterni)

### F9 — Modelli e costi
- ✅ F9.1 adattatori locali multipli (Ollama, OpenAI-compatibile, LM Studio…)
- ✅ F9.2 ledger budget con riserve atomiche e ricevute persistenti (`application/budgets.py`, `budget_settlement.py`)
- ◐ F9.3 settings separati (esiste il pannello, perimetro da ordinare)
- ◐ F9.4 diagnostica connessione (prova chat, `/v1/health`, `/v1/diagnostics/db`)
- ⬜ F9.5 routing automatico qualità/costo

### F10 — Release e operatività
- ✅ F10.1 installer Mac (DMG/ZIP arm64, pipeline firma/notarizzazione)
- ◐ F10.4 diagnostica: health con stato db, recovery mode con quarantena e diagnosi in chat, backup automatici giornalieri con retention
- ◐ F10.5 macchina pulita: restore drill verificato 2026-10-07; pilot 2-5 utenti da fare (dopo F5)
- ⬜ F10.2 stress 100 file/50 progetti; ⬜ F10.3 accessibilità; ◐ F10.6 inventario licenze

### Consegnato oltre il piano
- **Chat assistant-ui ufficiale**: thread del registry verbatim, streaming
  live con ragionamento separato, tool group dentro il thread, ragionamento
  e tool visibili anche nello storico (`feat f74e1eb0`)
- **Parity Hermes**: guardia turni 500 con riassunto al limite, sessione
  residente con snapshot, prompt tier volatile, web search ddgs
- **Robustezza DB**: recovery mode all'avvio (quarantena+ricostruzione+
  diagnosi narrata in chat), chiusura run zombie, CPU a riposo 1-2%
- **Canali reali**: WhatsApp via sidecar `wa-rs-bridge` (pairing vivo e
  riconnesso), adattatori Telegram/Discord/Slack/Matrix/Ntfy/webhook —
  il piano metteva WhatsApp in F11 fuori beta: anticipate
- **Desktop Electron** con motore incorporato e sessione autenticata
- **Kanban** (`kanban.db` + rotta) — prima del piano F11 "gruppi"

---

## 2. Debiti aperti verificati (non-previsti dal piano)

| Debito | Stato | Dove |
|---|---|---|
| ~~Vista Automazioni senza creazione~~ | ✅ corretto 2026-10-07: creator in vista con lavori modello pre-filtrati | `research/2026-10-07-feedback-desktop.md` |
| Vista Compiti/filtri incomprensibile | da rifare contro F5 (persona≠device) | idem |
| Connettori duplicati con i canali | da unificare/etichettare | idem |
| Errori connettore visibili | ✅ corretto 2026-10-07 | commit feedback |
| Gap parity Hermes: anti-loop in streaming, think inline nel pane, clean-EOF, coda al confine tool-call | da portare | `research/evidence/2026-10-07-parity-rc35/RIASSUNTO-TEST.md` |
| Anomalia: conversazione scomparsa dopo riavvio (2026-10-07) | da indagare se si ripete | log sessione |
| ConflictError transitorio in `expire_waiting` | osservato, non bloccante | sessione 2026-10-02 |

---

## 3. Cosa resta da fare, in ordine

1. **F5 — multiutente tra macchine**: specifica esecutiva pronta in
   `development/2026-10-07-f5-collaborazione-specifica.md` (6 fette con
   contratti e test, fondamenta esistenti mappate, decisioni D1–D4 con
   default proposto). Prima fetta: persone/ruoli/sessioni vere + inviti
   (3-4 giorni, nessuna rete, nessuna decisione pendente) — sblocca anche
   il rifacimento di Compiti. Gate: due Mac su reti diverse.
2. **Automazioni**: collegare la vista sidebar alle routine del motore
   (Fonte: motore) e completare F7.1 (conversazione→routine promossa).
3. **Connettori**: unificare catalogo connettori/canali, F6.1 ToolGrant,
   primo connettore verticale (Trello o equivalente scelto da Fabio).
4. **Gap parity Hermes** (quattro fix mirati, ~1 giorno).
5. **F10.2/F10.3** stress e accessibilità prima del pilot.
6. **F9.5** routing automatico (dopo dati di usage reali dal pilot).

### Regola di lavoro (invariata)
Contratto e gate prima dell'implementazione; test delle invarianti e dei
guasti; nessuna fase dichiarata completa con soli mock; Fonte:
simulazione|motore mai mescolate; errori tipizzati mai nascosti.

---

## 4. Archivio e fonti

- Piano storico fasi F0-F11 con testi originali: `development/2026-09-17-piano-sviluppo.md` (non rieseguire le fasi qui segnate fatte)
- Visione prodotto: `VISIONE-PRODOTTO.md` · uso: `USO-HOMUN.md` · motore/affidabilità: `MOTORE-AFFIDABILITA-E-FORMAZIONE.md`
- Evidenze per data: `research/` (80 documenti, archivio immutabile) · matrix parità Hermes: `research/evidence/`
- Stato tecnico precedente (congelato al 2026-09-30): `STATO.md` — sostituito da questo documento per l'avanzamento
- Registro documenti: `REGISTRO-DOCUMENTI.md`
