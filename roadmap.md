# Roadmap Homun

Aggiornata al 21 settembre 2026: percorsi motore reali e simulazione convivono esplicitamente. Lo [stato verificato](docs/STATO.md) e l’[ultima consegna](docs/research/2026-09-21-stabilita-conversazione.md) definiscono il perimetro provato; le funzioni del prototipo non diventano automaticamente funzionalità motore.

## Prototipo UX (simulato)

- [x] Backend, ruoli, isolamento progetti *(demo / IndexedDB, non motore)*
- [x] Chat con AI Elements + empty state *(simulazione)*
- [x] Automazioni, plugin, persone *(simulazione)*
- [x] Panoramica "viva": bot come collaboratori, attenzione, diario di bordo *(simulazione)*
- [x] Rifinire Automazioni e Plugin allo stesso livello (tema scuro editoriale)
- [x] Pagina "Crea": percorso guidato conversazionale + mappa visiva per automazioni e collaboratori
- [ ] Modalita mappa anche per i collaboratori (strumenti collegati come nodi)

## Prodotto reale (Homun 2)

- [x] Handshake locale client ↔ motore (`GET /v1/health`, `GET /v1/capabilities`)
- [x] Runtime adottato: Pydantic AI + DBOS (D-RUN-01; F0.2 PASS; hardening in ADR)
- [x] Dominio F1 in-process (Work/Plan/Conversation, comandi versionati, 14 test)
- [x] F2: SQLite + API + UI motore + wire chat (F2.4) + backup/restore (F2.5); cifratura ancora D-CRYPTO-01
- [x] F3.1: ModelRegistry + FakeProvider + OpenAI-compatible + secret store file-local + verify/complete API
- [x] ModelPort foundation: `Connection` + adapters (`fake` / `openai_compat` / pydantic_ai helpers); `GET /connections`, `POST /chat`; Settings «Prova chat»; ordine build LLM → agenti → memoria → progetti → flusso
- [x] Agents foundation slice A: `AgentProfile` + instructions/preferred_connection/status; `agent.update`; roster da store; Settings → Agenti; `GET /agents/{id}`
- [x] Mem0 local stack (F3.5a slice C): Ollama+Qdrant explicit config; dual-write isolation; `GET /v1/memory/status`; Settings recall
- [x] Projects + Teams B1: enriched `Project` + `Team` (members/coordinator); commands create/update/archive; `GET /projects` `/teams`; Settings → Progetti
- [x] AccessGrant B2: deny-by-default project grants; `grant.issue`/`revoke`; list/get filtered by capability; Settings grant UI
- [x] Materials B3: `MaterialVersion` metadata (note/link/file_ref); write-gated create; Settings materials UI (no binary upload)
- [x] F3.2: interpret strutturato (Pydantic AI / fake) + wire Fonte=motore + Ollama preset; comandi non eseguiti
- [x] F3.3: PlanDraft validato → plan.propose (o clarification sui campi mancanti); fake testabile senza Ollama
- [x] F3.4+: stessa patch chat/manuale (preview → Conferma/Annulla); F3.5 cancel/partial e F3.5a memoria locale aperti su Mem0/SSE
- [x] F3.5 UsageAttempt ledger: tentativi interpret (anche retry) legati a command/conversation; `GET /usage-attempts`; token sconosciuti restano null
- [x] F3.5 provider stream: OpenAI/Ollama SSE-NDJSON; live `/chat/stream`; `/commands/stream` tokens via ModelPort (`source=modelport`)
- [x] F3.5a gate: Settings rectify + export JSON; HTTP isolamento due progetti su list/recall/export
- [x] F3 acceptance gate (fake): tre intenti → plan; obiettivo stabile su 10 patch; no hardcoding settore in domain/planning
- [x] F4.1 durable runtime (C+B): DBOS workflow in engine, EffectReceipt idempotenti, Run + HTTP status; `features.runtime=true`
- [x] F4.2 materials ingest: blob archive + extract TXT/CSV/PDF; HTTP ingest; Settings + contributo chat con file; `features.materials=true`
- [x] Candidato Electron macOS arm64 con Python incorporato e verifica GUI nativa
- [ ] Distribuzione certificata: firma/notarizzazione, Mac pulito, aggiornamento e rollback
- [ ] Cifratura a riposo (D-CRYPTO-01)
- [x] Primo lavoro reale end-to-end: confronto CSV deterministico, approvazione, report e riavvio
- [x] Intake conversazionale: sintesi distinta, proposta agente/nuovo profilo, conferma e riepilogo compatto
- [x] Stabilità strutturale del brief nelle riformulazioni: campi modificati dichiarati, conservazione engine-side, diff esplicito e lettura non interrotta dai refresh
- [x] Stabilità della conversazione: scroll ancorato a chi legge (policy testata), attese del modello oneste nel transcript (fasi + tempo), 409 a versione stantia con recupero guidato e proposta stantia ritirata
- [x] Distinzione domanda/lavoro: classificazione backend senza stato, una domanda resta in chat senza creare lavori o collaboratori
- [x] Registro unico delle capacità: fonte singola per vocabolario, versione tool, limiti ed effetti; disponibilità interrogabile per attore; intake alimentato dal catalogo reale
- [x] Prompt esterni al codice e multilingua: file nel pacchetto con varianti it/en, store con fallback, lingua per workspace (`HOMUN_LANGUAGE`) e per richiesta, rilevamento automatico in classificazione
- [x] Seconda capacità locale limitata: lettura autorizzata di un materiale → artifact con estratto, provenienza e revisione umana (fonte condivisa con il confronto CSV, DBOS idempotente)
- [x] Budget per lavoro con riserve atomiche: persistito, riconciliazione con token reali o incognito (mai zero), recupero dei pendini, esaurimento tipizzato che si alza solo esplicitamente; collegato a intake, interpretazione e piano
- [x] Contesto autorizzato esteso: stato lavoro, accordo confermato, riferimenti materiali (versione/hash) e memoria nel contesto del modello, con rivalidazione identità prima degli effetti
- [ ] Loop operativo multi-tool e budget per delegati

## Consolidamento delle fondamenta — aggiornato al 19 settembre 2026

- [x] Comandi con fingerprint, replay verificato, ammissione transazionale e errori distinti.
- [x] Storage incrementale con rollback, migrazione e conflitti tra snapshot.
- [x] Dominio separato per funzione; confini e crescita legacy controllati in CI.
- [x] Outbox DBOS, recovery, arresto pulito e annullamento con esito incerto esplicito quando necessario.
- [x] Lock Python con hash verificato in ambiente nuovo; risultati aggiornati delle suite nello stato verificato.
- [x] Sessione locale legata al launcher, letture e replay con autorizzazioni correnti
- [ ] Identità multiutente esterne, driver cifrato/Keychain e distribuzione firmata
- [x] Ingestione con pubblicazione atomica e recovery; backup offline v2 di originali + runtime
- [x] Recupero automatico dei follow-up modello e accettazione del lavoro reale CSV
- [ ] Generalizzazione del loop con strumenti e budget oltre la capacità CSV

Dettagli e limiti: [stato corrente](docs/STATO.md). La [prima consegna delle fondamenta](docs/research/2026-09-19-production-foundations-delivery.md) conserva le prove storiche di quella tranche.
Le spunte attestano il perimetro provato; non certificano la release desktop o un agente autonomo completo.
