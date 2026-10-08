# Homun operativo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Portare l'uso diretto e la squadra aziendale alla stessa esperienza operativa, per incrementi verificati.
**Architecture:** Estendere i contratti esistenti, conservando dominio e DBOS come autorità. Separare esecutore, proprietario e revisore; mantenere tipizzati errori e risultati.
**Tech Stack:** Python/Pydantic/FastAPI/DBOS/SQLite; React/TypeScript/Electron.

## 1. Uso diretto Homun

- [x] Test prima delle modifiche: intake eseguibile senza staffing deve restare senza staffing; conferma non crea agenti, conserva owner umano e pubblica piano; sintesi su connessione attiva produce artifact in review. Delega esplicita continua a usare connessione dell'agente.
- [x] `engine/src/homun/models/intake.py` e prompt it/en: rimuovere obbligo/fallback staffing, mantenendo validazione delle proposte esplicite.
- [x] `engine/src/homun/application/intake.py`: confermare lavoro diretto senza agent.create e senza spostare owner; conservare controllo revisione/digest/permessi.
- [x] `engine/src/homun/application/synthesis.py` e `synthesis_execution.py`: risolvere esecutore Homun senza AgentProfile artificiale; connessione attiva, budget lavoro, provenienza esplicita, validazione di deleghe non più attive.
- [x] Componenti intake/esecuzione e helper condivisi: Homun come default, specializzazione facoltativa; niente falso collaboratore/persona come modello.
- [x] Eseguire test intake/synthesis/budget/phase e test client; verificare nuove regressioni prima di review e commit.

## 2. Ciclo operativo adattivo

- [x] Definire decisione tipizzata e catalogo strumenti con osservazioni persistite; testare risposta, lettura autorizzata, seconda decisione, limiti e riavvio.
- [x] Collegare catalogo/decisione a ModelPort e workflow durabile; riusare verifica materiali, artifact, autorizzazioni e budget.
- [x] Collegare proposta/avvio/stato alla chat e verificare il percorso completo; pausa/cancellazione del dominio bloccano pubblicazioni tardive. Controlli UX dedicati restano da semplificare.

## 3. Azienda e squadra

- [x] Contratto persistente del contesto aziendale e proposta di squadra versionata, usando AgentProfile/Team esistenti.
- [x] Percorso opzionale con modulo di contesto e proposta per descrizione, correzione e conferma; creazione idempotente e capacità dichiarate reali.
- [x] Registro destinatari e contributi distinti con credenziali circoscritte; identità dichiarata tramite link, non account personale verificato. Nessuna distribuzione remota implicita.

## 4. Accettazione e integrazione

- [x] Review requisiti e qualità indipendenti, correzione dei rilievi.
- [x] Suite completa, contratti OpenAPI, architettura, build e prova UI del percorso.
- [x] Aggiornare stato/guida/limiti, commit locali, integrazione verificata su main; nessun push o rilascio implicito.

I dettagli dei successivi incrementi vengono fissati sul codice risultante dal precedente, prima di implementarli. Le spunte attestano il perimetro del rapporto operativo, non la visione completa. Restano account verificati, rete tra installazioni, onboarding interamente in chat e strumenti web/MCP.
