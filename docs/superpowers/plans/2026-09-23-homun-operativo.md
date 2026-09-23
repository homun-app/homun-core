# Homun operativo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Portare l'uso diretto e la squadra aziendale alla stessa esperienza operativa, per incrementi verificati.
**Architecture:** Estendere i contratti esistenti, conservando dominio e DBOS come autorità. Separare esecutore, proprietario e revisore; mantenere tipizzati errori e risultati.
**Tech Stack:** Python/Pydantic/FastAPI/DBOS/SQLite; React/TypeScript/Electron.

## 1. Uso diretto Homun

- [ ] Test prima delle modifiche: intake eseguibile senza staffing deve restare senza staffing; conferma non crea agenti, conserva owner umano e pubblica piano; sintesi su connessione attiva produce artifact in review. Delega esplicita continua a usare connessione dell'agente.
- [ ] `engine/src/homun/models/intake.py` e prompt it/en: rimuovere obbligo/fallback staffing, mantenendo validazione delle proposte esplicite.
- [ ] `engine/src/homun/application/intake.py`: confermare lavoro diretto senza agent.create e senza spostare owner; conservare controllo revisione/digest/permessi.
- [ ] `engine/src/homun/application/synthesis.py` e `synthesis_execution.py`: risolvere esecutore Homun senza AgentProfile artificiale; connessione attiva, budget lavoro, provenienza esplicita, validazione di deleghe non più attive.
- [ ] Componenti intake/esecuzione e helper condivisi: Homun come default, specializzazione facoltativa; niente falso collaboratore/persona come modello.
- [ ] Eseguire test intake/synthesis/budget/phase e test client; verificare nuove regressioni prima di review e commit.

## 2. Ciclo operativo adattivo

- [ ] Definire decisione tipizzata e catalogo strumenti con osservazioni persistite; testare risposta, lettura autorizzata, seconda decisione, limiti e riavvio.
- [ ] Collegare catalogo/decisione a ModelPort e workflow durabile; riusare verifica materiali, artifact, autorizzazioni e budget.
- [ ] Collegare proposta/avvio/stato/cancellazione alla chat e verificare il percorso completo.

## 3. Azienda e squadra

- [ ] Contratto persistente del contesto aziendale e proposta di squadra versionata, usando AgentProfile/Team esistenti.
- [ ] Percorso conversazionale per descrizione, proposta, correzione e conferma; creazione idempotente e capacità dichiarate reali.
- [ ] Registro identità e contributi distinti, autorizzazioni e accesso coerenti con sessione e distribuzione locale.

## 4. Accettazione e integrazione

- [ ] Review requisiti e qualità indipendenti, correzione dei rilievi.
- [ ] Suite completa, contratti OpenAPI, architettura, build e prova UI del percorso.
- [ ] Aggiornare stato/guida/limiti, commit locali, integrazione verificata su main; nessun push o rilascio implicito.

I dettagli dei successivi incrementi vengono fissati sul codice risultante dal precedente, prima di implementarli. Le caselle aperte restano lavoro richiesto, non feature consegnate.
