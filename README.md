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

La barra in cima all’app web mostra se il motore è connesso. La simulazione è una fonte esplicita; selezionare «Fonte: motore» con processo spento o senza capability `domain` mostra un errore esplicito, senza ricaduta silenziosa sulla demo.

La separazione dei sorgenti permette di evolvere la nuova app conservando il riferimento UX. Le due versioni condividono per ora dipendenze e risorse pubbliche. I vecchi collegamenti ai sorgenti `src/` nella documentazione storica corrispondono ora a `prototypes/reference/src/`; il codice destinato alla nuova app è in `apps/web/src/`.

## Stato reale

La UI distingue esplicitamente simulazione e motore. Il motore dispone di dominio persistito, profili agenti, progetti, materiali, memoria approvata, interpretazione dei messaggi e runtime DBOS con outbox. La tranche del 19 settembre consolida comandi, transazioni e recovery: non costituisce ancora un prodotto pronto alla distribuzione.

Sono disponibili ingestione durevole, backup completo offline v2, recupero dei follow-up, contesto autorizzato e app Electron con motore incorporato. Il nuovo flusso propone titolo, obiettivo e collaboratore prima della conferma. Il confronto reale di due listini CSV è stato eseguito nella GUI fino al report e recuperato dopo riavvio senza duplicati. Questo non certifica un agente generalista completo.

Restano aperti qualità delle riformulazioni, registro generale degli strumenti, budget aggregati, parità delle superfici UI, identità multiutente/peer, cifratura/Keychain e distribuzione firmata con prova su Mac pulito. Le dipendenze storiche Supabase/TanStack restano per il riferimento e non costituiscono una scelta per il nuovo backend.

Partire dallo [stato verificato corrente](docs/STATO.md), dalla [specifica di passaggio](docs/handoff/2026-09-19-ripresa-sviluppo-homun.md) e dalle [ultime prove native](docs/research/2026-09-19-conversational-intake-ux-verification.md). L’[indice documentale](docs/README.md) distingue requisiti e rapporti storici.

La versione esistente in `../app` resta indipendente. La sostituzione avverrà secondo `docs/development/transizione-homun.md`. Nessuna pubblicazione automatica è configurata. Rispettare le istruzioni Lovable di `AGENTS.md` senza riscrivere storia pubblicata.
