# Contratti condivisi

La descrizione canonica dell'API HTTP attuale è [`openapi/v1-engine.json`](openapi/v1-engine.json), generata deterministicamente da `create_app().openapi()`. Include tutte le route registrate e i modelli dichiarati a FastAPI; le risposte ancora dichiarate come dizionari generici non hanno uno schema di dominio completo. I tipi del prototipo React non sono contratti del motore. Un client TypeScript generato resta un lavoro successivo.

## Generazione e controllo

Dalla root del repository, con le dipendenze engine installate:

```sh
engine/.venv/bin/python tools/export_openapi.py --write
engine/.venv/bin/python tools/export_openapi.py --check
```

Il generatore usa i sorgenti `engine/src` di questo checkout, ordina le chiavi JSON e non avvia server/lifespan, non crea un contesto e non apre il database dell'utente. In CI si usa `python tools/export_openapi.py --check` dopo l'installazione dell'engine. Una differenza interrompe il controllo: aggiornare lo snapshot insieme alle modifiche delle route.

## Identità e autorizzazione

Gli header attore compaiono opzionali nello schema perché la sessione autenticata può fornirli. Questo non rende anonime le letture protette.

- Sessione locale protetta: `Authorization: Bearer <token>` è richiesto dal middleware, anche per health/capabilities. L'identità è quella associata alla sessione dal launcher. Un `X-Homun-Actor-Id` assente viene inserito dal middleware; se presente deve coincidere con l'attore associato. Identità diversa o header duplicato restituisce HTTP 403 `session_actor_mismatch`. Il nome inviato dal client non modifica l'identità. Token assente/non valido restituisce HTTP 401 `session_required`; un'origine non consentita restituisce HTTP 403 `origin_denied`.
- Modalità di sviluppo esplicitamente non protetta: le route che richiedono un attore usano `X-Homun-Actor-Id`, con nome facoltativo `X-Homun-Actor-Name`; se manca l'ID restituiscono HTTP 401 `unauthorized`. Questi header di sviluppo non costituiscono autenticazione per un ambiente condiviso.
- Le letture di lavori/run e gli eventi applicano i grant attuali dei progetti collegati. Il dettaglio negato restituisce HTTP 403 `permission_denied`; liste ed eventi escludono i record non leggibili. I grant sono leggibili dal proprio soggetto o dagli admin attuali del progetto. Negli eventi di creazione progetto l'eventuale `admin_grant_id` non leggibile viene omesso senza nascondere il progetto leggibile.

La protezione Bearer è middleware configurato all'avvio e non viene inferita da FastAPI come `securityScheme`: queste regole completano lo snapshot generato.

## Paginazione degli eventi filtrati

`GET /v1/workspaces/{workspace_id}/events?after=0&limit=100` restituisce `items` e `cursor`. `limit` (1–500) limita i record esaminati, non soltanto quelli visibili. Un'intera pagina può essere filtrata: `items` vuoto con `cursor` avanzato non significa fine dello storico. Continuare usando `after=cursor` finché il cursore non cambia. Il cursore espone la posizione nella sequenza, mai il contenuto degli eventi negati. Revoche e scadenze si applicano anche alle successive letture dello storico.

## Riferimenti precedenti

- [`openapi/v1-health.yaml`](openapi/v1-health.yaml) e [`openapi/v1-domain.yaml`](openapi/v1-domain.yaml) sono descrizioni manuali parziali delle tranche iniziali/F2, conservate come riferimento storico; non descrivono tutta l'API attuale.
- [`schemas/domain-f1.json`](schemas/domain-f1.json) descrive le forme della tranche F1; non sostituisce i modelli correnti del motore.
- Persistenza attuale: SQLite locale non cifrato; cifratura = D-CRYPTO-01.

La specifica di prodotto per la superficie completa resta in `docs/specifications/04-api-client-rete.md`.
