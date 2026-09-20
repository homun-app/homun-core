# Consegna: bundle macOS autonomo

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

> Candidato aggiornato e correzioni successive: [affidabilità desktop e backup](2026-09-19-desktop-reliability-delivery.md).

19 settembre 2026, prosecuzione di “Continua”. Creato un candidato locale macOS
Apple Silicon con Electron, build web e motore Python incorporato. Nessun commit,
push, pubblicazione, certificato Developer ID o dato reale utilizzato.

## Artefatto verificato

`dist/desktop/2026-09-19T08-40-14-097Z/Homun-darwin-arm64/Homun.app`

Archivio: `dist/desktop/2026-09-19T08-40-14-097Z/Homun-0.1.0-macos-arm64.zip`

181.700.783 byte; SHA-256:
`deac74cbf3b7ecdf52bb6a4974feb4742e1de98258b9d3babc676aa0a8e4b559`.
Il checksum è disponibile anche nel file `.zip.sha256` accanto all'archivio.

**Candidato locale, non release certificata.** L'eseguibile ha firma ad-hoc,
nessun TeamIdentifier, nessuna firma Developer ID o notarizzazione. Non sono state
aggirate protezioni macOS. La versione UI nativa resta da verificare: il tentativo
ha raggiunto il timeout e il controllo della sessione ha confermato il Mac bloccato.
La prova browser della tranche precedente rimane evidenza distinta.

## Build e confini

```sh
npm ci
npm run desktop:build
```

`tools/build_engine_bundle.py` crea un virtualenv temporaneo con CPython **3.13.12**,
dipendenze runtime e packaging bloccate separatamente per hash. PyInstaller **6.22.3**
produce `dist/engine/homun-engine` più `_internal`. Il virtualenv di sviluppo non
viene modificato e l'eseguibile incorporato non lo usa. I sorgenti Pydantic/Logfire
necessari all'introspezione sono inclusi dopo un errore di avvio rilevato nello smoke.
L'extra Mem0/Qdrant rimane escluso; nessun modello, peso o segreto è incorporato.

`apps/desktop/scripts/package-app.mjs` usa Electron **44.4.3** e Packager **20.3.0**.
Copia quattro moduli shell espliciti, verifica i tipi di asset web, rifiuta file
nascosti/inattesi e valida l'inventario del motore. La ricevuta engine confronta
versione Python, lock, sorgenti e configurazione build; 842 file/link generati sono
legati a hash o destinazione del link. File aggiunti, mancanti, alterati, link che
escono dal bundle e input diventati obsoleti fanno fallire il packaging.

La copia finale del motore preserva i link relativi. Questo corregge un difetto
osservato in `extraResource` di Packager, che li trasformava in riferimenti alle
cartelle temporanee. L'inventario viene ricontrollato **dentro la .app**, prima dello
ZIP. I dieci link del motore finale sono relativi e si risolvono dentro il bundle.
La ricevuta engine finale ha SHA-256
`3d4aa1ca80cb11cb936b2b92e8b09e6a5363ea4a59a7996cd407440761a3226d`.

Build con input congelati, non promessa di output identico byte per byte fra host,
SDK e firme. Il workflow manuale `.github/workflows/desktop-bundle.yml` prepara un
candidato equivalente su runner macOS arm64; è stato scritto, non eseguito su GitHub.
Riferimenti: [Packager](https://electron.github.io/packager/main/),
[runner GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Prove completate

- Smoke del binario standalone e del binario **dentro Homun.app**, da directory
  temporanea, senza PYTHONPATH e con PATH `/nonexistent`.
- Health autenticata 200, richiesta senza token 401, runtime attivo, registro provider.
- Lavoro durevole in attesa, arresto, nuovo processo, contributo, completamento,
  replay identico e una sola ricevuta; migrazioni DBOS fino a 114; shutdown verificato.
- Tre test del proprietario eseguiti anche sul binario incorporato: arresto normale,
  cancellazione durante startup e morte improvvisa del desktop.
- Inventario finale ricontrollato da review indipendente; ASAR contiene solo manifest
  e i quattro moduli attesi, corrispondenti ai sorgenti.
- ZIP verificato su 3718 voci, CRC e SHA-256. Copia estratta in una nuova directory
  temporanea: inventario valido e smoke completo riuscito, incluso riavvio durevole
  e replay con una sola ricevuta, senza Python globale.
- Sei test Node desktop/packaging e un test inventario Python riusciti.
- `npm run check`: 121 test, typecheck, entrambe le build riusciti; architettura zero
  errori, 30 avvisi legacy. `npm audit`: zero vulnerabilità segnalate.

La suite backend completa della tranche precedente resta **218 passati / 1 Mem0 live
saltato**; qui il codice runtime non è stato cambiato. Le nuove prove verificano
l'esecuzione frozen e il packaging, non provider reali né prestazioni di produzione.

## Restano aperti

Smoke grafico Electron e flussi completi nel pacchetto; Mac pulito senza strumenti
di sviluppo; firma/notarizzazione e identità stabile; update/rollback; altre
architetture; Keychain, cifratura operativa e recupero chiavi; autorizzazione uniforme.
Nessuna migrazione automatica del vecchio workspace e nessun uso di credenziali reali.
