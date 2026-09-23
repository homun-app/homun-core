# Homun 2

Nuova base di Homun: interfaccia React, applicazione installabile Electron e motore Python accessibile tramite API. Il futuro client Flutter potrà utilizzare le stesse API.

## Struttura

- `apps/web/`: nuova interfaccia React; percorsi motore reali e simulazione del prototipo mantenuti espliciti.
- `apps/desktop/`: shell Electron e candidato macOS arm64 autonomo con motore incorporato e sessione autenticata.
- `engine/`: spazio dedicato al motore Python.
- `packages/ui/`: componenti React condivisi.
- `contracts/`: confine API e futuri contratti generati.
- `prototypes/`: prototipi navigabili e copia autonoma dei sorgenti di riferimento.
- `docs/specifications/`: requisiti di prodotto, agenti, settings, permessi e API.
- `docs/development/`: piano di sviluppo e passaggio dal vecchio Homun.
- `tests/`: verifiche della logica attuale.

## Avvio locale

Usare npm e Node 24 o successivo. Installare con `npm ci`. `.npmrc` conserva la compatibilità con i peer dependency del template storico; riallinearli prima della fase release.

- `npm run dev`: nuova app su http://127.0.0.1:4183.
- `npm run dev:prototype`: riferimento su http://127.0.0.1:4182.
- `npm run check`: TypeScript, test, build app e build prototipi.
- `npm run engine:install` poi `npm run engine:dev`: motore locale su http://127.0.0.1:8765 (`GET /v1/health`, `GET /v1/capabilities`). Richiede `uv` per il venv in `engine/.venv`.
- `npm run desktop:dev`: build web e shell Electron; richiede il virtualenv del motore.
- `npm run desktop:build`: candidato macOS arm64 con Python incluso, senza firma di distribuzione.
- `npm run desktop:test`: confine desktop, autenticazione locale e proprietà del processo.
- `npm run engine:test`: suite del motore, incluse persistenza, API, outbox e riavvio del runtime.
- `npm run architecture:check`: confini dei moduli, cicli e limiti di crescita dei file.

Il percorso di produzione usa il motore. La diagnostica e gli errori rendono visibile la connessione; il selettore della simulazione è uno strumento di sviluppo, non il percorso di primo avvio. Un motore indisponibile non viene sostituito da dati demo.

La separazione dei sorgenti permette di evolvere la nuova app conservando il riferimento UX. Le due versioni condividono per ora dipendenze e risorse pubbliche. I vecchi collegamenti ai sorgenti `src/` nella documentazione storica corrispondono ora a `prototypes/reference/src/`; il codice destinato alla nuova app è in `apps/web/src/`.

## Stato reale — 23 settembre 2026

Il consolidamento `8b7658b2` è integrato su `main`. Homun dispone di chat con
accordo supervisionato, collaboratori e team, piani per fasi, materiali,
confronto CSV, lettura, sintesi, procedure approvate, budget e scadenze,
risultati revisionabili e routine. Materiali, Plugin e Compiti laterali usano
le operazioni persistenti del motore.

Partire dalla [guida d'uso](docs/USO-HOMUN.md), dallo
[stato verificato](docs/STATO.md) e dal [passaggio corrente](docs/handoff/2026-09-23-consolidamento-e-ux.md).
Il [confronto d'uso con Hermes](docs/research/2026-09-23-hermes-homun-utilizzo.md)
prepara la discussione UX. L'[indice](docs/README.md) e il
[registro documentale](docs/REGISTRO-DOCUMENTI.md) distinguono istruzioni correnti,
requisiti e fotografie storiche.

Restano aperti recupero degli effetti MCP esterni, identità fra installazioni,
cifratura completa e recupero chiavi, qualità dei modelli sui casi del pilot,
semplificazione dei percorsi e certificazione di upgrade/Mac pulito. Il lint
conserva debito precedente; controlli e limiti sono nel rapporto di consolidamento.

Il vecchio prodotto in `../app` resta indipendente; la migrazione segue
[criteri dedicati](docs/development/transizione-homun.md). La pipeline di
[release](docs/release.md) reagisce ai tag e pubblica draft: un commit locale
non distribuisce una release. Il branch collegato a Lovable mantiene la sua
storia; rispettare `AGENTS.md`. Le dipendenze del riferimento storico non
costituiscono una scelta di backend per Homun 2.
